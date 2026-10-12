// electron/main/weekly/aggregator.ts
//
// Pulls together everything the weekly view needs for one ISO week:
// Live rollups for unfinished weeks, durable snapshots for generated reports.
// Source changes never invalidate a saved report; only Regenerate replaces it.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { MeetingsRepo, MeetingRow } from '../storage/meetings-repo.js';
import type { ActionItemsRepo, ActionItemRow } from '../storage/action-items-repo.js';
import type { SpeakersRepo } from '../storage/speakers-repo.js';
import type { SettingsRepo } from '../storage/settings-repo.js';
import type { WeeklySummariesRepo, WeeklySummaryRow } from '../storage/weekly-summaries-repo.js';
import { isoWeekRange } from '../lib/iso-week.js';
import { meetingFolderPath } from '../storage/meeting-folder.js';
import { extractOverviewRecap } from './recap.js';
import type { WeeklyTheme, WeeklyMeeting, WeeklyOwnerGroup, WeeklyStructured, WeeklySnapshot, WeeklyNarrative, WeeklyData } from '../ipc/contracts.js';
export type { WeeklyTheme, WeeklyMeeting, WeeklyActionItem, WeeklyOwnerGroup, WeeklyStructured, WeeklyNarrative, WeeklyData } from '../ipc/contracts.js';

// ──────── Public types ────────

/** A topic thread synthesized across the week's meetings. The recall
 *  payload of the weekly view — connects discussions that span multiple
 *  meetings, which clicking into a single meeting can't surface. */
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
export class WeeklyAggregator {
  /** In-flight narrative generations, keyed by `${year}:${week}`.
   *  Concurrent callers (e.g. the user clicking the prev arrow twice
   *  before the first LLM call returns) share one promise so we
   *  never queue duplicate chat requests behind LM Studio's
   *  serial inference pipeline. Entries clear themselves on
   *  resolution or rejection. */
  private narrativeInFlight = new Map<string, Promise<WeeklyNarrative>>();

  constructor(private readonly deps: AggregatorDeps) {}

  /** Fast path: saved report sections, or a live rollup before generation.
   *  Legacy rows acquire their missing structured snapshot once, without an LLM. */
  async getStructuredWeek(isoYear: number, isoWeek: number): Promise<WeeklyStructured> {
    const saved = this.getSavedReport(isoYear, isoWeek);
    if (saved?.snapshot) {
      return { ...saved.snapshot, hasFreshCache: true, savedAt: saved.generatedAt };
    }
    return { ...this.buildLiveWeek(isoYear, isoWeek), hasFreshCache: false };
  }

  private buildLiveWeek(isoYear: number, isoWeek: number): WeeklySnapshot {
    const { start, end } = isoWeekRange(isoYear, isoWeek);
    const startIso = start.toISOString();
    const endIso = end.toISOString();
    const meetings = this.deps.meetings.listInRange(startIso, endIso);
    const inProgress = end.getTime() > Date.now();
    const totalDurationS = meetings.reduce((s, m) => s + (m.durationS ?? 0), 0);
    const weeklyMeetings = meetings.map((m) => this.buildWeeklyMeeting(m));
    const openActionGroups = this.collectOpenActions(meetings);
    const openActionCount = openActionGroups.reduce((s, g) => s + g.items.length, 0);

    return {
      isoYear, isoWeek,
      rangeStart: startIso,
      rangeEnd: endIso,
      totalDurationS,
      meetings: weeklyMeetings,
      openActionGroups,
      openActionCount,
      inProgress,
    };
  }

  private getSavedReport(isoYear: number, isoWeek: number): WeeklySummaryRow | null {
    const saved = this.deps.weeklySummaries.get(isoYear, isoWeek);
    if (saved && !saved.snapshot) {
      const snapshot = { ...this.buildLiveWeek(isoYear, isoWeek), inProgress: false,
        legacySnapshot: true, capturedAt: new Date().toISOString() };
      this.deps.weeklySummaries.captureLegacySnapshot(isoYear, isoWeek, snapshot);
      return this.deps.weeklySummaries.get(isoYear, isoWeek);
    }
    return saved;
  }

  private savedNarrative(saved: WeeklySummaryRow): WeeklyNarrative {
    return { narrative: saved.narrative, themes: saved.themes, decisions: saved.decisions,
      generatedAt: saved.generatedAt, fromCache: true, snapshot: saved.snapshot ?? undefined };
  }

  /** Returns any saved narrative, otherwise generates the first report.
   *  The two-call split (getStructuredWeek
   *  first, then this) means the renderer can paint the layout
   *  before this resolves. Pass `force: true` to replace the saved report
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
    // Readers can keep using the saved report while an explicit replacement
    // is in flight. Failed regeneration must never hide the previous report.
    if (!opts.force) {
      const saved = this.getSavedReport(isoYear, isoWeek);
      if (saved) return this.savedNarrative(saved);
    }
    const key = `${isoYear}:${isoWeek}`;
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
      if (opts.force && this.deps.weeklySummaries.get(isoYear, isoWeek)) {
        throw new Error('Wait until this week ends to regenerate. Your saved report has been kept.');
      }
      return { narrative: '', themes: [], decisions: [], generatedAt: '', fromCache: false };
    }
    const meetings = this.deps.meetings.listInRange(
      start.toISOString(),
      end.toISOString(),
    );
    const inputHash = this.computeInputHash(meetings);
    if (meetings.length === 0) {
      if (opts.force && this.deps.weeklySummaries.get(isoYear, isoWeek)) {
        throw new Error('No source meetings remain for this week. Your saved report has been kept.');
      }
      return { narrative: '', themes: [], decisions: [], generatedAt: '', fromCache: false };
    }
    const weeklyMeetings = meetings.map((m) => this.buildWeeklyMeeting(m));
    const openActionGroups = this.collectOpenActions(meetings);
    const snapshot: WeeklySnapshot = {
      isoYear, isoWeek, rangeStart: start.toISOString(), rangeEnd: end.toISOString(),
      totalDurationS: meetings.reduce((sum, m) => sum + (m.durationS ?? 0), 0),
      meetings: weeklyMeetings, openActionGroups,
      openActionCount: openActionGroups.reduce((sum, group) => sum + group.items.length, 0),
      inProgress: false,
      capturedAt: new Date().toISOString(),
    };
    const out = await this.regenerate(
      isoYear, isoWeek, meetings, weeklyMeetings, openActionGroups, inputHash, snapshot,
    );
    return {
      narrative: out.narrative,
      themes: out.themes,
      decisions: out.decisions,
      generatedAt: out.generatedAt,
      fromCache: false,
      snapshot,
    };
  }

  /** Returns one consistent report, including for Markdown export. */
  async getWeek(isoYear: number, isoWeek: number): Promise<WeeklyData> {
    const narrative = await this.getOrGenerateNarrative(isoYear, isoWeek);
    const structured = narrative.snapshot
      ? { ...narrative.snapshot, hasFreshCache: true, savedAt: narrative.generatedAt }
      : await this.getStructuredWeek(isoYear, isoWeek);
    const { hasFreshCache: _drop, ...structuredOut } = structured;
    void _drop;
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
    const narrative = await this.getOrGenerateNarrative(isoYear, isoWeek, { force: true });
    const structured = narrative.snapshot
      ? { ...narrative.snapshot, hasFreshCache: true, savedAt: narrative.generatedAt }
      : await this.getStructuredWeek(isoYear, isoWeek);
    const { hasFreshCache: _drop, ...out } = structured; void _drop;
    return { ...out, narrative: narrative.narrative, themes: narrative.themes,
      decisions: narrative.decisions, generatedAt: narrative.generatedAt };
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
          ownerName: ownerLabel,
          sourceQuote: it.sourceQuote,
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
    const ownerIds = new Set(meetings.flatMap(m => this.deps.actionItems.listByMeeting(m.id)
      .map(item => item.ownerSpeakerId).filter((id): id is string => id !== null)));
    // Hash the actual source content, not incidental timestamp mutations.
    // This catches summary/terminology/history edits and all task/roster paths.
    const payload = JSON.stringify({
      meetings: sorted.map(m => {
        let summary: string | null = null;
        try { summary = fs.readFileSync(path.join(meetingFolderPath(this.deps.libraryRoot, m.slug), 'summary.md'), 'utf8'); } catch { /* absent summary */ }
        return { id: m.id, title: m.title, startedAt: m.startedAt, durationS: m.durationS,
          updatedAt: m.updatedAt, summary, actions: this.deps.actionItems.listByMeeting(m.id).sort((a, b) => a.id.localeCompare(b.id)) };
      }),
      roster: this.deps.speakers.list().filter(s => ownerIds.has(s.id)).map(s => [s.id, s.displayName]).sort((a, b) => a[0]!.localeCompare(b[0]!)),
      userSpeakerId: this.deps.settings.get('userSpeakerId'),
    });
    return crypto.createHash('sha256').update(payload).digest('hex');
  }

  private async regenerate(
    isoYear: number,
    isoWeek: number,
    meetings: readonly MeetingRow[],
    weeklyMeetings: readonly WeeklyMeeting[],
    openActionGroups: readonly WeeklyOwnerGroup[],
    inputHash: string,
    snapshot: WeeklySnapshot,
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

    const { start, end } = isoWeekRange(isoYear, isoWeek);
    const current = this.deps.meetings.listInRange(start.toISOString(), end.toISOString());
    if (this.computeInputHash(current) !== inputHash) {
      throw new Error('This week changed while its overview was being generated. Refresh to generate from the current notes and tasks.');
    }
    this.deps.weeklySummaries.upsert({
      isoYear,
      isoWeek,
      narrative: out.narrative,
      themes: out.themes,
      decisions: out.decisions,
      inputHash,
      snapshot,
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
