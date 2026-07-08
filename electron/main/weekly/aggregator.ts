// electron/main/weekly/aggregator.ts
//
// Pulls together everything the weekly view needs for one ISO week:
// the list of meetings, action items grouped by owner, and the cached
// LLM narrative (or a freshly-generated one when the input hash
// invalidates the cache). No state of its own — all storage goes
// through the repos.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { MeetingsRepo, MeetingRow } from '../storage/meetings-repo.js';
import type { ActionItemsRepo, ActionItemRow } from '../storage/action-items-repo.js';
import type { SpeakersRepo } from '../storage/speakers-repo.js';
import type { SettingsRepo } from '../storage/settings-repo.js';
import type { WeeklySummariesRepo } from '../storage/weekly-summaries-repo.js';
import { isoWeekRange } from '../lib/iso-week.js';
import { meetingFolderPath } from '../storage/meeting-folder.js';
import { extractOverviewRecap } from './recap.js';

// ──────── Public types ────────

/** A topic thread synthesized across the week's meetings. The recall
 *  payload of the weekly view — connects discussions that span multiple
 *  meetings, which clicking into a single meeting can't surface. */
export interface WeeklyTheme {
  title: string;
  /** 2-4 sentences: what was discussed, where it landed, what's open. */
  detail: string;
  /** Source meeting titles this thread draws from, for traceability. */
  meetings: string[];
}

export interface WeeklyMeeting {
  id: string;
  title: string;
  startedAt: string;
  durationS: number | null;
  /** Multi-sentence recap pulled from the meeting's summary Overview, if
   *  available. Used as the in-list recap for catching up. */
  highlight: string | null;
  /** Number of distinct speakers identified in diarization. Null if
   *  the meeting hasn't been diarized yet. */
  speakerCount: number | null;
}

export interface WeeklyActionItem {
  id: string;
  meetingId: string;
  meetingTitle: string;
  /** Display text. */
  text: string;
  /** Resolved owner display name. Falls back to owner_name (free
   *  text) when no roster speaker is linked. Null = unowned. */
  ownerLabel: string | null;
  /** True if the owner matches settings.userSpeakerId — pinned to
   *  the top of the UI as the "You" group. */
  isYou: boolean;
  status: string;
  dueDate: string | null;
  /** Source meeting's startedAt. Used by the view to label items
   *  with "Mon" / "Tue" etc. */
  meetingStartedAt: string;
}

export interface WeeklyOwnerGroup {
  ownerLabel: string;
  isYou: boolean;
  items: WeeklyActionItem[];
}

export interface WeeklyData {
  isoYear: number;
  isoWeek: number;
  /** ISO timestamps for the Mon 00:00 / Sun 23:59 bounds. */
  rangeStart: string;
  rangeEnd: string;
  /** Total meeting time across the week, in seconds. */
  totalDurationS: number;
  meetings: WeeklyMeeting[];
  /** Open action items, grouped by owner. "You" group (if any)
   *  always appears first. */
  openActionGroups: WeeklyOwnerGroup[];
  /** Total open count across all groups (avoids the renderer having
   *  to re-sum). */
  openActionCount: number;
  /** LLM-generated 2-3 paragraph narrative. Empty string when the
   *  week has no meetings. */
  narrative: string;
  /** LLM-synthesized topic threads across the week. */
  themes: WeeklyTheme[];
  /** LLM-extracted decisions list. */
  decisions: string[];
  /** When the cached narrative + decisions were generated. Empty
   *  string when no cache exists yet (i.e., narrative === ''). */
  generatedAt: string;
  /** True when the week contains at least one meeting whose
   *  started_at is in the future of "now" (i.e. the user is viewing
   *  the in-progress current week). The view shows an "in progress"
   *  badge in this case. */
  inProgress: boolean;
}

// ──────── Implementation ────────

export interface AggregatorDeps {
  meetings: MeetingsRepo;
  actionItems: ActionItemsRepo;
  speakers: SpeakersRepo;
  settings: SettingsRepo;
  weeklySummaries: WeeklySummariesRepo;
  libraryRoot: string;
  /** Generates the LLM narrative from the structured week data.
   *  Pluggable so tests can supply a deterministic fake. */
  generateNarrative: (data: NarrativeInput) => Promise<NarrativeOutput>;
  /** Wakes the LM Studio supervisor before the narrative call.
   *  No-op for v1; reserved for Phase 3. */
  ensureLLMReady?: () => Promise<void>;
}

export interface NarrativeInput {
  weekLabel: string;
  meetings: Array<{ title: string; startedAt: string; durationS: number | null; summaryMd: string | null }>;
  openActions: Array<{ owner: string; text: string; due: string | null }>;
}

export interface NarrativeOutput {
  narrative: string;
  themes: WeeklyTheme[];
  decisions: string[];
}

/** What `getStructuredWeek` returns — everything the renderer needs
 *  to lay out the page WITHOUT making an LLM call. Returned in tens
 *  of ms so the page doesn't sit blank while the model thinks. */
export interface WeeklyStructured {
  isoYear: number;
  isoWeek: number;
  rangeStart: string;
  rangeEnd: string;
  totalDurationS: number;
  meetings: WeeklyMeeting[];
  openActionGroups: WeeklyOwnerGroup[];
  openActionCount: number;
  inProgress: boolean;
  /** True when the cached narrative is still valid for the current
   *  input set. Lets the renderer skip the spinner when the second
   *  IPC call is going to return instantly anyway. */
  hasFreshCache: boolean;
}

/** What `getOrGenerateNarrative` returns. */
export interface WeeklyNarrative {
  narrative: string;
  themes: WeeklyTheme[];
  decisions: string[];
  generatedAt: string;
  /** True when the result came from the cache (no LLM call made). */
  fromCache: boolean;
}

export class WeeklyAggregator {
  /** In-flight narrative generations, keyed by `${year}:${week}`.
   *  Concurrent callers (e.g. the user clicking the prev arrow twice
   *  before the first LLM call returns) share one promise so we
   *  never queue duplicate chat requests behind LM Studio's
   *  serial inference pipeline. Entries clear themselves on
   *  resolution or rejection. */
  private narrativeInFlight = new Map<string, Promise<WeeklyNarrative>>();

  constructor(private readonly deps: AggregatorDeps) {}

  /** Fast path: meetings + action items + decisions buckets, no
   *  LLM call. Returns within ~10s of an action-item-heavy week and
   *  much faster for a typical week. The renderer paints this
   *  immediately, then a separate getOrGenerateNarrative() call
   *  fills in the Overview card.
   *
   *  Idempotent + side-effect-free; safe to call repeatedly. */
  async getStructuredWeek(isoYear: number, isoWeek: number): Promise<WeeklyStructured> {
    const { start, end } = isoWeekRange(isoYear, isoWeek);
    const startIso = start.toISOString();
    const endIso = end.toISOString();
    const meetings = this.deps.meetings.listInRange(startIso, endIso);
    const inProgress = end.getTime() > Date.now();
    const totalDurationS = meetings.reduce((s, m) => s + (m.durationS ?? 0), 0);
    const weeklyMeetings = meetings.map((m) => this.buildWeeklyMeeting(m));
    const openActionGroups = this.collectOpenActions(meetings);
    const openActionCount = openActionGroups.reduce((s, g) => s + g.items.length, 0);

    const inputHash = this.computeInputHash(meetings);
    const cached = this.deps.weeklySummaries.get(isoYear, isoWeek);
    const hasFreshCache = !!(cached && cached.inputHash === inputHash);

    return {
      isoYear, isoWeek,
      rangeStart: startIso,
      rangeEnd: endIso,
      totalDurationS,
      meetings: weeklyMeetings,
      openActionGroups,
      openActionCount,
      inProgress,
      hasFreshCache,
    };
  }

  /** Slow path: returns the cached narrative if fresh, otherwise
   *  triggers an LLM call. The two-call split (getStructuredWeek
   *  first, then this) means the renderer can paint the layout
   *  before this resolves. Pass `force: true` to bypass the cache
   *  (used by the "Regenerate" button).
   *
   *  Concurrent calls for the same week share an in-flight promise —
   *  the user can click the prev arrow twice before the first LLM
   *  call returns and we won't queue a duplicate chat request behind
   *  LM Studio's serial inference pipeline. */
  async getOrGenerateNarrative(
    isoYear: number,
    isoWeek: number,
    opts: { force?: boolean } = {},
  ): Promise<WeeklyNarrative> {
    const key = `${isoYear}:${isoWeek}:${opts.force ? 'force' : 'normal'}`;
    const existing = this.narrativeInFlight.get(key);
    if (existing) return existing;
    const promise = this.runGetOrGenerate(isoYear, isoWeek, opts)
      .finally(() => { this.narrativeInFlight.delete(key); });
    this.narrativeInFlight.set(key, promise);
    return promise;
  }

  private async runGetOrGenerate(
    isoYear: number,
    isoWeek: number,
    opts: { force?: boolean },
  ): Promise<WeeklyNarrative> {
    const { start, end } = isoWeekRange(isoYear, isoWeek);
    // Skip narrative generation for the current (in-progress) week —
    // meetings keep getting added all week, so any LLM output goes
    // stale within hours and the compute is wasted. The view shows a
    // friendly explanation in place of the Overview card. Even the
    // Regenerate button (force=true) is gated because the answer
    // would be obsolete by the time the user reads it.
    const inProgress = end.getTime() > Date.now();
    if (inProgress) {
      return { narrative: '', themes: [], decisions: [], generatedAt: '', fromCache: false };
    }
    const meetings = this.deps.meetings.listInRange(
      start.toISOString(),
      end.toISOString(),
    );
    const inputHash = this.computeInputHash(meetings);
    const cached = this.deps.weeklySummaries.get(isoYear, isoWeek);
    if (!opts.force && cached && cached.inputHash === inputHash) {
      return {
        narrative: cached.narrative,
        themes: cached.themes,
        decisions: cached.decisions,
        generatedAt: cached.generatedAt,
        fromCache: true,
      };
    }
    if (meetings.length === 0) {
      return { narrative: '', themes: [], decisions: [], generatedAt: '', fromCache: false };
    }
    if (opts.force) {
      this.deps.weeklySummaries.clear(isoYear, isoWeek);
    }
    const weeklyMeetings = meetings.map((m) => this.buildWeeklyMeeting(m));
    const openActionGroups = this.collectOpenActions(meetings);
    const out = await this.regenerate(
      isoYear, isoWeek, meetings, weeklyMeetings, openActionGroups, inputHash,
    );
    return {
      narrative: out.narrative,
      themes: out.themes,
      decisions: out.decisions,
      generatedAt: out.generatedAt,
      fromCache: false,
    };
  }

  /** Returns the full week's data, generating + caching the narrative
   *  when the input hash has changed since the last cached row.
   *  Equivalent to getStructuredWeek + getOrGenerateNarrative
   *  squashed into one call — kept for backward compat with the
   *  weeklyGet IPC. New callers should prefer the split pair so
   *  the renderer can show the structured view while the narrative
   *  is still being drafted. */
  async getWeek(isoYear: number, isoWeek: number): Promise<WeeklyData> {
    const [structured, narrative] = await Promise.all([
      this.getStructuredWeek(isoYear, isoWeek),
      this.getOrGenerateNarrative(isoYear, isoWeek),
    ]);
    const { hasFreshCache: _drop, ...structuredOut } = structured;
    return {
      ...structuredOut,
      narrative: narrative.narrative,
      themes: narrative.themes,
      decisions: narrative.decisions,
      generatedAt: narrative.generatedAt,
    };
  }

  /** Forces narrative regeneration even when the input hash is
   *  unchanged. Used by the renderer's "Regenerate" button. */
  async regenerateWeek(isoYear: number, isoWeek: number): Promise<WeeklyData> {
    this.deps.weeklySummaries.clear(isoYear, isoWeek);
    return this.getWeek(isoYear, isoWeek);
  }

  // ──────── Internals ────────

  private buildWeeklyMeeting(m: MeetingRow): WeeklyMeeting {
    const folder = meetingFolderPath(this.deps.libraryRoot, m.slug);
    const summaryPath = path.join(folder, 'summary.md');
    let highlight: string | null = null;
    if (fs.existsSync(summaryPath)) {
      try {
        const md = fs.readFileSync(summaryPath, 'utf8');
        // A multi-sentence recap from the summary's Overview section — enough
        // to recall what the meeting was about without opening it.
        highlight = extractOverviewRecap(md);
      } catch { /* best-effort */ }
    }
    // Speaker count comes from the tiny diarization.meta.json sidecar —
    // parsing the full diarization.json (multi-MB of per-segment
    // embeddings) per meeting per weekly open was measurably slow. For
    // meetings that predate the sidecar, parse the big file ONCE and
    // write the meta file as a self-healing cache.
    let speakerCount: number | null = null;
    const metaPath = path.join(folder, 'diarization.meta.json');
    const diarPath = path.join(folder, 'diarization.json');
    if (fs.existsSync(metaPath)) {
      try {
        const d = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as { num_speakers?: number };
        speakerCount = typeof d.num_speakers === 'number' ? d.num_speakers : null;
      } catch { /* best-effort */ }
    } else if (fs.existsSync(diarPath)) {
      try {
        const d = JSON.parse(fs.readFileSync(diarPath, 'utf8')) as { num_speakers?: number };
        speakerCount = typeof d.num_speakers === 'number' ? d.num_speakers : null;
        if (speakerCount !== null) {
          try {
            fs.writeFileSync(metaPath, JSON.stringify({ num_speakers: speakerCount }));
          } catch { /* best-effort cache write */ }
        }
      } catch { /* best-effort */ }
    }
    return {
      id: m.id,
      title: m.title,
      startedAt: m.startedAt ?? m.createdAt,
      durationS: m.durationS,
      highlight,
      speakerCount,
    };
  }

  private collectOpenActions(meetings: readonly MeetingRow[]): WeeklyOwnerGroup[] {
    const userSpeakerId = this.deps.settings.get('userSpeakerId');
    // Build a quick speaker_id → display_name lookup to resolve
    // owner labels without N round-trips per item.
    const speakers = this.deps.speakers.list();
    const speakerName = new Map(speakers.map((s) => [s.id, s.displayName]));

    const byOwner = new Map<string, WeeklyOwnerGroup>();
    for (const m of meetings) {
      const items = this.deps.actionItems.listByMeeting(m.id);
      for (const it of items) {
        if (it.status !== 'open') continue;
        const ownerLabel = this.resolveOwnerLabel(it, speakerName);
        const isYou = userSpeakerId != null && it.ownerSpeakerId === userSpeakerId;
        const key = isYou ? '__YOU__' : (ownerLabel ?? '__UNOWNED__');
        const group = byOwner.get(key) ?? {
          ownerLabel: isYou ? 'You' : (ownerLabel ?? 'Unassigned'),
          isYou,
          items: [],
        };
        group.items.push({
          id: it.id,
          meetingId: m.id,
          meetingTitle: m.title,
          text: it.text,
          ownerLabel: isYou ? 'You' : ownerLabel,
          isYou,
          status: it.status,
          dueDate: it.dueDate,
          meetingStartedAt: m.startedAt ?? m.createdAt,
        });
        byOwner.set(key, group);
      }
    }

    // Sort: "You" first, then alphabetical by label, with Unassigned last.
    const groups = [...byOwner.values()];
    groups.sort((a, b) => {
      if (a.isYou !== b.isYou) return a.isYou ? -1 : 1;
      const aUn = a.ownerLabel === 'Unassigned';
      const bUn = b.ownerLabel === 'Unassigned';
      if (aUn !== bUn) return aUn ? 1 : -1;
      return a.ownerLabel.localeCompare(b.ownerLabel);
    });
    return groups;
  }

  private resolveOwnerLabel(
    it: ActionItemRow,
    speakerName: Map<string, string>,
  ): string | null {
    if (it.ownerSpeakerId && speakerName.has(it.ownerSpeakerId)) {
      return speakerName.get(it.ownerSpeakerId) ?? null;
    }
    return it.ownerName ?? null;
  }

  private computeInputHash(meetings: readonly MeetingRow[]): string {
    const sorted = [...meetings].sort((a, b) => a.id.localeCompare(b.id));
    const payload = sorted.map((m) => `${m.id}:${m.updatedAt}`).join('|');
    return crypto.createHash('sha256').update(payload).digest('hex');
  }

  private async regenerate(
    isoYear: number,
    isoWeek: number,
    meetings: readonly MeetingRow[],
    weeklyMeetings: readonly WeeklyMeeting[],
    openActionGroups: readonly WeeklyOwnerGroup[],
    inputHash: string,
  ): Promise<{ narrative: string; themes: WeeklyTheme[]; decisions: string[]; generatedAt: string }> {
    if (this.deps.ensureLLMReady) await this.deps.ensureLLMReady();

    // Build the structured input for the prompt. Each meeting
    // contributes its existing summary.md so the LLM has source
    // material for the narrative; if a meeting hasn't been
    // summarized yet, we pass an empty body and the LLM is told to
    // skip it.
    const meetingsForPrompt = meetings.map((m) => {
      const folder = meetingFolderPath(this.deps.libraryRoot, m.slug);
      const summaryPath = path.join(folder, 'summary.md');
      const summaryMd = fs.existsSync(summaryPath)
        ? fs.readFileSync(summaryPath, 'utf8')
        : null;
      return {
        title: m.title,
        startedAt: m.startedAt ?? m.createdAt,
        durationS: m.durationS,
        summaryMd,
      };
    });

    const openActions: Array<{ owner: string; text: string; due: string | null }> = [];
    for (const g of openActionGroups) {
      for (const it of g.items) {
        openActions.push({
          owner: g.ownerLabel,
          text: it.text,
          due: it.dueDate,
        });
      }
    }

    const weekLabel = `${weeklyMeetings[0]?.startedAt ?? ''} – ISO ${isoYear}-W${String(isoWeek).padStart(2, '0')}`;
    const out = await this.deps.generateNarrative({
      weekLabel,
      meetings: meetingsForPrompt,
      openActions,
    });

    this.deps.weeklySummaries.upsert({
      isoYear,
      isoWeek,
      narrative: out.narrative,
      themes: out.themes,
      decisions: out.decisions,
      inputHash,
    });

    const cached = this.deps.weeklySummaries.get(isoYear, isoWeek);
    return {
      narrative: out.narrative,
      themes: out.themes,
      decisions: out.decisions,
      generatedAt: cached?.generatedAt ?? new Date().toISOString(),
    };
  }
}
