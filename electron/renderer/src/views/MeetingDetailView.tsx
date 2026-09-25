// electron/renderer/src/views/MeetingDetailView.tsx
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api } from '../ipc/client';
import { useElapsed, fmtElapsed } from '../lib/useElapsed';
import { fmtEta, isRunningLong } from '../lib/fmtEta';
import { MeetingRowMenu } from '../components/MeetingRowMenu';
import { MoveToGroupDialog } from '../components/MoveToGroupDialog';
import { setUnsavedGuard } from '../lib/unsaved-guard';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Icon } from '../components/icons';
import { nextPlaybackRate, fmtPlaybackRate, guardedSeek, SKIP_SECONDS } from '../lib/audio-controls';
import { isKnownReasoningModel } from '../lib/reasoning-models';
import { REASONING_LOOP_MARKER } from '../lib/reasoning-loop';
import { USER_STEPS, stepIndexFor } from '../lib/pipeline-steps';
import { createDetailArtifacts, mergeSpeakerReview, type DetailArtifactState, type DetailSpeaker } from '../lib/detail-artifacts';
import { MeetingExportPanel } from './MeetingExportPanel';
import { SpeakersPanel } from './MeetingSpeakersPanel';
import { ActionItemsPanel, Placeholder } from './MeetingActionsPanel';
import { TranscriptPanel } from './MeetingTranscriptPanel';

// Audio is no longer a tab — it lives in a sticky footer below the
// center pane so playback stays alive while the user reads the summary
// or transcript. See #42. Actions tab exposes inline edit / add / delete
// for the action items that used to only surface in the export modal. #44
type Tab = 'summary' | 'transcript' | 'actions';

export interface MeetingDetail {
  id: string;
  title: string;
  groupId: string | null;
  groupName: string | null;
  startedAt: string | null;
  durationS: number | null;
  pipelineStage: string;
  status: string;
  errorMessage: string | null;
  stageStartedAt: string | null;
  stageEtaMs: number | null;
  stageEtaRough: boolean;
  skipSpeakerId: boolean;
  transcriptMd: string | null;
  rawTranscriptText: string | null;
  summaryMd: string | null;
  audioPath: string;
  userIdentified: boolean;
  speakers: DetailSpeaker[];
  actionItems: {
    id: string;
    text: string;
    ownerName: string | null;
    dueDate: string | null;
    status: string;
    exportedTo: string[];
    sourceQuote: string | null;
    isMine: boolean;
  }[];
  models: { stt?: string; llm?: string };
}

type MeetingShell = Omit<MeetingDetail, 'transcriptMd' | 'rawTranscriptText'>;

// User-facing pipeline step model lives in lib/pipeline-steps so the
// LibraryRow chip and the StageTimeline below agree on counts and labels.

export function MeetingDetailView({
  id, onBack, seekSeconds, hint,
}: {
  id: string;
  onBack: () => void;
  /** When set (e.g. coming from the search palette), seek the audio to
   *  this time once it's loadable and switch to the Transcript tab so
   *  the matched line is visible. (#42 / #45) */
  seekSeconds?: number;
  /** Row hints captured at click-time so the loading skeleton can
   *  paint with real values (title, current pipeline stage) instead
   *  of "Loading…" placeholders while the lightweight shell resolves. */
  hint?: { title?: string; pipelineStage?: string; status?: string };
}): JSX.Element {
  const [shell, setShell] = useState<MeetingShell | null>(null);
  const [moveGroupOpen, setMoveGroupOpen] = useState(false);
  const [, setArtifactVersion] = useState(0);
  const [artifacts] = useState(() => createDetailArtifacts({
    transcript: async (meetingId: string) => {
      const result = await api.meetings.getTranscript(meetingId);
      if (result === null) throw new Error('Meeting is no longer available.');
      return result;
    },
    speakerReview: async (meetingId: string) => {
      const result = await api.meetings.getSpeakerReview(meetingId);
      if (result === null) throw new Error('Meeting is no longer available.');
      return result;
    },
  }, () => setArtifactVersion((version) => version + 1)));
  useEffect(() => {
    artifacts.selectMeeting(id);
    return () => artifacts.selectMeeting(null);
  }, [artifacts, id]);
  const transcript = artifacts.get('transcript');
  const speakerReview = artifacts.get('speakerReview');
  // Shell refreshes must never erase optional content already on screen.
  const m: MeetingDetail | null = useMemo(() => shell?.id === id ? {
    ...shell,
    transcriptMd: transcript.data?.transcriptMd ?? null,
    rawTranscriptText: transcript.data?.rawTranscriptText ?? null,
    speakers: mergeSpeakerReview(shell.speakers, speakerReview.data?.speakers),
  } : null, [shell, id, transcript.data, speakerReview.data]);
  const [tab, setTab] = useState<Tab>('summary');
  useEffect(() => {
    if (shell?.id === id && (tab === 'transcript' || seekSeconds !== undefined)) {
      void artifacts.request(id, 'transcript');
    }
  }, [artifacts, id, shell?.id, tab, seekSeconds]);
  useEffect(() => {
    if (shell?.id !== id) return;
    // Two frames put the optional review request after the first shell paint.
    let nextFrame: number | undefined;
    const frame = requestAnimationFrame(() => {
      nextFrame = requestAnimationFrame(() => { void artifacts.request(id, 'speakerReview'); });
    });
    return () => {
      cancelAnimationFrame(frame);
      if (nextFrame !== undefined) cancelAnimationFrame(nextFrame);
    };
  }, [artifacts, id, shell?.id]);
  // Provenance jump (#provenance): when the user clicks "Show source" on an
  // action item, we switch to the Summary tab and ask SummaryPanel to
  // highlight the bullet whose text matches `quote`. `nonce` lets re-clicking
  // the same item re-trigger the scroll/highlight even though `quote` is
  // unchanged. Mirrors how `seekSeconds` drives the transcript jump.
  const [provenance, setProvenance] = useState<{ quote: string; nonce: number } | null>(null);
  const showSource = (quote: string): void => {
    setTab('summary');
    setProvenance((p) => ({ quote, nonce: (p?.nonce ?? 0) + 1 }));
  };
  // Lifted audio state so the transcript's click-to-seek + current-line
  // highlight can reach the <audio> element in the sticky footer. The
  // ref survives tab switches; tab switches alone never unmount the
  // player. (#42)
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  // timeupdate fires ~4x/sec, but the transcript highlight only changes
  // at whole-second granularity. Quantize the state update to 1/sec so
  // playback doesn't re-render the whole detail tree 4x/sec.
  const lastFlooredTimeRef = useRef(0);
  const onTimeUpdate = useCallback((e: React.SyntheticEvent<HTMLAudioElement>): void => {
    const floored = Math.floor((e.target as HTMLAudioElement).currentTime);
    if (floored === lastFlooredTimeRef.current) return;
    lastFlooredTimeRef.current = floored;
    setCurrentTime(floored);
  }, []);
  // Stable identity: passed down to every (memoized) transcript row —
  // a fresh function per render would defeat React.memo on the rows.
  const seekTo = useCallback((seconds: number): void => {
    const el = audioRef.current;
    if (!el) return;
    el.currentTime = seconds;
    if (el.paused) void el.play();
  }, []);

  // Playback controls (#A3): speed cycle + ±15s skips. The chosen rate is
  // per-session component state; a ref mirrors it so the loadedmetadata
  // re-apply (rates reset when a new src loads) and the keydown handler
  // below stay identity-stable.
  const [rate, setRate] = useState(1);
  const rateRef = useRef(1);
  const cycleRate = useCallback((): void => {
    const next = nextPlaybackRate(rateRef.current);
    rateRef.current = next;
    setRate(next);
    if (audioRef.current) audioRef.current.playbackRate = next;
  }, []);
  const applyRate = useCallback((): void => {
    if (audioRef.current) audioRef.current.playbackRate = rateRef.current;
  }, []);
  // Relative skip. Unlike seekTo (click-to-seek), a skip on a paused
  // player stays paused — the user is scrubbing, not asking for playback.
  const skipBy = useCallback((delta: number): void => {
    const el = audioRef.current;
    if (!el) return;
    el.currentTime = guardedSeek(el.currentTime, delta, el.duration);
  }, []);

  // Keyboard transport: Space play/pause, ←/→ skip ∓/±15s. Ignored while
  // typing (input/textarea/select/contentEditable) or with any modifier
  // held, so cmd-K, shift-selection etc. pass through untouched. Space is
  // additionally ignored when a button/link has focus — Space must keep
  // activating the focused control (arrows still seek there, which is
  // what makes them work right after clicking a transcript row).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest('input,textarea,select,[contenteditable]')) return;
      const el = audioRef.current;
      if (!el) return;
      if (e.code === 'Space') {
        if (t?.closest('button,[role="button"],a')) return;
        e.preventDefault(); // don't scroll the page
        if (el.paused) void el.play(); else el.pause();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        el.currentTime = guardedSeek(el.currentTime, -SKIP_SECONDS, el.duration);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        el.currentTime = guardedSeek(el.currentTime, SKIP_SECONDS, el.duration);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Palette-driven jump (#45): when opened with `seekSeconds`, switch to
  // the transcript tab and seek the audio once it's ready. readyState >= 1
  // means metadata is loaded and `currentTime` writes will stick;
  // otherwise the seek silently drops.
  useEffect(() => {
    if (seekSeconds === undefined) return;
    setTab('transcript');
    const el = audioRef.current;
    if (!el) return;
    const apply = (): void => seekTo(seekSeconds);
    if (el.readyState >= 1) apply();
    else el.addEventListener('loadedmetadata', apply, { once: true });
    return () => el.removeEventListener('loadedmetadata', apply);
  }, [seekSeconds, id, m?.id, seekTo]);

  // Summary edit session (#A2). Lives HERE, not in SummaryPanel: the panel
  // is conditionally rendered (`tab === 'summary' && …`), so a tab switch
  // unmounts it — state kept inside the panel died with it and silently
  // discarded the user's edits. `summarySaved` is the local baseline (what
  // we believe is on disk); it advances on save, ahead of `m.summaryMd`
  // catching up via reload. dirty = draft !== baseline.
  const [summaryMode, setSummaryMode] = useState<SummaryMode>('view');
  const [summaryDraft, setSummaryDraft] = useState('');
  const [summarySaved, setSummarySaved] = useState('');
  const summaryDirty = summaryDraft !== summarySaved;

  // Seed / reset the session, keyed on meeting id + on-disk summary. A
  // meeting switch always reseeds; a summaryMd change on the SAME meeting
  // (re-summarize, save-reload round trip) only reseeds when there are no
  // unsaved edits to lose. The ref makes re-runs from unrelated renders
  // (polls, dirty flips) cheap no-ops.
  const summarySeedRef = useRef<{ id: string; original: string } | null>(null);
  useEffect(() => {
    if (m === null) return;
    const original = m.summaryMd ?? '';
    const prev = summarySeedRef.current;
    if (prev !== null && prev.id === m.id && prev.original === original) return;
    const idChanged = prev === null || prev.id !== m.id;
    summarySeedRef.current = { id: m.id, original };
    if (idChanged || !summaryDirty) {
      setSummaryDraft(original);
      setSummarySaved(original);
      if (idChanged) setSummaryMode('view');
    }
  }, [m, summaryDirty]);

  // While dirty, register the global unsaved-edits guard so destructive
  // exits (back button below, App-level meeting switches via the search
  // palette / URL scheme / status bar / history) confirm before discarding.
  // The guard is asynchronous: it opens a styled ConfirmDialog and resolves
  // with the user's answer, replacing the old window.confirm (#192).
  const [discardOpen, setDiscardOpen] = useState(false);
  const discardResolveRef = useRef<((ok: boolean) => void) | null>(null);
  useEffect(() => {
    if (!summaryDirty) return;
    setUnsavedGuard(() => new Promise<boolean>((resolve) => {
      // A second navigation attempt while the dialog is open resolves the
      // first (denied) so it can't dangle.
      discardResolveRef.current?.(false);
      discardResolveRef.current = resolve;
      setDiscardOpen(true);
    }));
    return () => {
      discardResolveRef.current = null;
      setUnsavedGuard(null);
    };
  }, [summaryDirty]);

  function settleDiscard(ok: boolean): void {
    setDiscardOpen(false);
    const resolve = discardResolveRef.current;
    discardResolveRef.current = null;
    resolve?.(ok);
    // If declined, the draft stays dirty and the effect re-registers the
    // guard on the next dirty flip — no action needed here.
  }

  // `kick` is a deliberate re-run trigger for the polling effect. Mutations
  // that change the meeting's live state (rerun, speaker assign) bump it so
  // the effect tears down its old timer and starts fresh — polling resumes
  // even after the meeting had already settled at 'done'.
  const [kick, setKick] = useState(0);
  const reload = async (): Promise<void> => {
    setKick((k) => k + 1);
  };

  // Stage events refresh the shell immediately. A slower DB-only poll covers
  // events missed while the renderer was suspended or reloading.
  const lastLiveStateRef = useRef<{
    pipelineStage: string; status: string; errorMessage: string | null;
  } | null>(null);

  useEffect(() => {
    let alive = true;
    let requestSerial = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    async function load(): Promise<void> {
      if (timer) { clearTimeout(timer); timer = null; }
      const request = ++requestSerial;
      const d = (await api.meetings.get(id)) as MeetingShell | null;
      if (!alive || request !== requestSerial) return;
      setShell(d);
      if (d === null) return;
      void artifacts.refresh(id);
      lastLiveStateRef.current = {
        pipelineStage: d.pipelineStage,
        status: d.status,
        errorMessage: d.errorMessage,
      };
      // Poll while anything is in flight. A rerun puts the meeting back into
      // 'processing', which re-enters this branch via the `kick` dependency.
      if (d.status === 'processing') {
        timer = setTimeout(poll, 15000);
      }
    }
    // Light poll tick: DB-only status snapshot. Refreshes the shell
    // the moment stage/status/error changed (or the meeting vanished
    // — load()'s null handling is the same either way).
    async function poll(): Promise<void> {
      let st: Awaited<ReturnType<typeof api.meetings.getStatus>>;
      try {
        st = await api.meetings.getStatus(id);
      } catch {
        st = null;
      }
      if (!alive) return;
      if (st === null) {
        // Meeting vanished (deleted?) or the IPC failed — let the full
        // load path decide what to render.
        await load();
        return;
      }
      const last = lastLiveStateRef.current;
      const changed = last === null
        || st.pipelineStage !== last.pipelineStage
        || st.status !== last.status
        || st.errorMessage !== last.errorMessage;
      if (changed) {
        // Stage advanced / failed / finished — refresh the shell and
        // previously requested artifacts, including any raw preview.
        // load() reschedules polling itself while still processing.
        await load();
        return;
      }
      // No state change: keep the cheap live fields (eta, counts) fresh
      // without re-shipping the transcript, and keep polling.
      const snap = st;
      setShell((prev) => (prev === null || prev.id !== id ? prev : {
        ...prev,
        title: snap.title,
        stageStartedAt: snap.stageStartedAt,
        stageEtaMs: snap.stageEtaMs,
        stageEtaRough: snap.stageEtaRough,
        skipSpeakerId: snap.skipSpeakerId,
      }));
      if (snap.status === 'processing') {
        timer = setTimeout(poll, 15000);
      }
    }
    const unsubscribeStage = api.pipeline.onMeetingStageChange((meetingId) => {
      if (meetingId === id) void load();
    });
    void load();
    return () => {
      alive = false;
      unsubscribeStage();
      if (timer) clearTimeout(timer);
    };
  }, [artifacts, id, kick]);

  if (!m)
    return <DetailSkeleton hint={hint} onBack={onBack} />;

  return (
    // Detail card fills the available height inside App's flex column,
    // then internally splits into [pinned header] / [scrollable grid] /
    // [pinned audio]. Title bar, stage timeline, and parked-banner stay
    // on screen while the user reads a long summary or transcript.
    <div className="max-w-6xl mx-auto my-6 h-[calc(100%-3rem)] bg-surface rounded-xl shadow-pop border border-surface-border overflow-hidden flex flex-col">
      <div className="shrink-0 flex items-center gap-3 px-5 py-3 border-b border-surface-border">
        {/* onBack (App's history goBack) consults the unsaved-edits guard
            itself — do NOT guard again here, or a dirty summary would
            prompt the discard dialog twice. */}
        <button
          onClick={onBack}
          className="text-ink-muted hover:text-ink text-sm shrink-0"
        >
          ← Library
        </button>
        {/* min-w-0 lets the truncate actually clip long titles instead of
            forcing the flex row to overflow — otherwise a long title would
            push the actions menu off the right edge. Click-to-edit (#A5):
            the same rename IPC the ⋯ menu uses, without the modal. */}
        <div className="flex-1 min-w-0 text-center px-2">
          <EditableTitle id={m.id} title={m.title} onRenamed={() => void reload()} />
          <button type="button" title={`Change group (currently ${m.groupName ?? 'Ungrouped'})`}
            aria-label={`Change group for ${m.title} (currently ${m.groupName ?? 'Ungrouped'})`}
            onClick={() => setMoveGroupOpen(true)}
            className="mt-0.5 max-w-full inline-flex items-center gap-1 text-[11px] text-ink-muted hover:text-brand-indigo focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-indigo/40 rounded px-1">
            <svg viewBox="0 0 20 20" className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M2 5h6l2 2h8v9H2z" /></svg>
            <span className="truncate">{m.groupName ?? 'Add to group'}</span>
          </button>
        </div>
        {/* Actions menu: rename/delete from the detail view. When the user
            deletes from here, route back to Library since the detail we're
            viewing no longer exists. */}
        <div className="relative w-[68px] flex justify-end shrink-0">
          <MeetingRowMenu
            meeting={{ id: m.id, title: m.title, groupId: m.groupId, groupName: m.groupName }}
            onChanged={() => void reload()}
            onDeleted={() => onBack()}
          />
        </div>
      </div>

      {moveGroupOpen && <MoveToGroupDialog ids={[m.id]} meeting={m} onClose={() => setMoveGroupOpen(false)} onChanged={() => void reload()} />}

      {/* Parked-at-gate banner renders ABOVE the timeline. The gate is the
          one moment in the pipeline where the UI is waiting for a human
          decision; hiding it below 8 pipeline chips hurt the time-to-
          action. Returns null when not parked. */}
      <div className="shrink-0">
        <SpeakerIdControls meeting={m} onReload={reload} placement="above-timeline" />
      </div>

      {/* Failure banner: when a run failed, surface WHY (the error string the
          pipeline caught, e.g. "whisper: not ready ...") with a one-click
          Retry — instead of leaving the user with a bare red X on the
          timeline and no explanation. Returns null when not failed. */}
      <div className="shrink-0">
        <FailureBanner meeting={m} onReload={reload} />
      </div>

      {/* The timeline is the canonical "where is this meeting in the pipeline"
          display. Always rendered — for never-processed meetings every stage
          is pending, while processing the current stage spins, after
          completion it's a persistent point-in-time record, and after a
          rerun kick the stages downstream of the rerun point flip back to
          pending so the progress is visible as it happens again. */}
      <div className="shrink-0">
        <StageTimeline meeting={m} />
      </div>

      {/* Quiet pre-gate skip-toggle row. Returns null when parked — the
          parked banner above already exposes the same control. */}
      <div className="shrink-0">
        <SpeakerIdControls meeting={m} onReload={reload} placement="below-timeline" />
      </div>

      {/* Responsive layout: stack single-column below lg (1024px) so the
          narrow rails don't clip center-pane content (transcript / audio
          player / summary). min-w-0 on each cell lets flex/grid children
          actually shrink — without it long lines of text force horizontal
          overflow and the whole detail view gets cut off on the right.
          On narrow, the CenterPane renders first (content first), then
          LeftRail and RightRail below, so users aren't scrolling past
          sidebar meta to reach the transcript. On lg+ the grid
          columns-order lands them back in their natural visual order.

          Scroll model:
            • lg+ (3 columns): each rail scrolls on its own — center
              pane can show a 50-page summary while the speakers/export
              rail stays visible.
            • Below lg (stacked): the grid itself scrolls as one column
              because per-section overflow would create awkward nested
              scrollbars on narrow widths. */}
      <div className="grid grid-cols-1 lg:grid-cols-[220px_minmax(0,1fr)_240px] flex-1 min-h-0 overflow-y-auto lg:overflow-hidden">
        <div className="order-1 lg:order-none min-w-0 lg:overflow-y-auto">
          <CenterPane
            meeting={m}
            tab={tab}
            onTab={setTab}
            currentTime={currentTime}
            onSeek={seekTo}
            onReload={reload}
            onShowSource={showSource}
            provenance={provenance}
            summaryMode={summaryMode}
            onSummaryMode={setSummaryMode}
            summaryDraft={summaryDraft}
            onSummaryDraft={setSummaryDraft}
            summarySaved={summarySaved}
            onSummaryBaseline={setSummarySaved}
            transcriptState={transcript}
            onRetryTranscript={() => void artifacts.request(id, 'transcript')}
          />
        </div>
        <div className="order-2 lg:order-first min-w-0 lg:overflow-y-auto"><LeftRail meeting={m} onReload={reload} /></div>
        <div className="order-3 min-w-0 lg:overflow-y-auto"><RightRail meeting={m} onReload={reload}
          speakerReviewState={speakerReview} onRetrySpeakerReview={() => void artifacts.request(id, 'speakerReview')} /></div>
      </div>

      {/* Audio player pinned to the bottom of the card. Lives outside the
          CenterPane so it stays visible while the user reads the summary
          OR transcript — no more "switch tabs to play". Click-to-seek on
          transcript lines pipes through `seekTo` to this element. */}
      <div className="shrink-0 bg-surface-sunken border-t border-surface-border px-5 py-3 flex items-center gap-2">
        {/* Transport controls (#A3). Keyboard: Space play/pause, ←/→ ∓/±15s. */}
        <button
          type="button"
          onClick={() => skipBy(-SKIP_SECONDS)}
          title="Back 15 seconds (←)"
          aria-label="Back 15 seconds"
          className="shrink-0 text-xs font-semibold text-ink-muted hover:text-ink bg-surface border border-surface-border rounded-lg px-2.5 py-1.5 tabular-nums transition inline-flex items-center gap-1"
        >
          <Icon name="rotate-ccw" className="w-3 h-3" />
          15s
        </button>
        <button
          type="button"
          onClick={() => skipBy(SKIP_SECONDS)}
          title="Forward 15 seconds (→)"
          aria-label="Forward 15 seconds"
          className="shrink-0 text-xs font-semibold text-ink-muted hover:text-ink bg-surface border border-surface-border rounded-lg px-2.5 py-1.5 tabular-nums transition inline-flex items-center gap-1"
        >
          15s
          <Icon name="rotate-cw" className="w-3 h-3" />
        </button>
        <button
          type="button"
          onClick={cycleRate}
          title="Playback speed — click to cycle"
          aria-label={`Playback speed ${fmtPlaybackRate(rate)} — click to cycle`}
          className="shrink-0 min-w-[3.75rem] text-xs font-semibold text-ink-muted hover:text-ink bg-surface border border-surface-border rounded-lg px-2.5 py-1.5 tabular-nums transition"
        >
          {fmtPlaybackRate(rate)}
        </button>
        <audio
          ref={audioRef}
          controls
          src={`file://${m.audioPath}`}
          onTimeUpdate={onTimeUpdate}
          onLoadedMetadata={applyRate}
          className="flex-1 min-w-0"
        />
      </div>

      {/* Unsaved-summary discard confirmation (#192). Opened by the async
          unsaved-edits guard registered above; resolves the pending
          navigation promise with the user's answer. */}
      <ConfirmDialog
        open={discardOpen}
        title="Discard unsaved summary edits?"
        body="Your edits to the summary haven't been saved. Leaving this meeting now discards them."
        confirmLabel="Discard"
        destructive
        onConfirm={() => settleDiscard(true)}
        onCancel={() => settleDiscard(false)}
      />
    </div>
  );
}

/** Click-to-edit meeting title for the detail header (#A5). Display mode
 *  is a button with a quiet hover affordance (dotted underline + faint
 *  pencil) so the interaction is discoverable without shouting; clicking
 *  swaps in an input seeded with the current title, focused + selected.
 *  Enter saves, Esc cancels, blur saves-if-changed; an empty/whitespace
 *  title cancels rather than saving. Persists through the SAME
 *  meetings:rename IPC the ⋯ menu's rename dialog uses, then reloads. */
function EditableTitle({
  id, title, onRenamed,
}: {
  id: string;
  title: string;
  onRenamed: () => void;
}): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(title);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Set when Enter/Esc already resolved the edit, so the blur the
  // resolution itself triggers doesn't commit a second time (or commit
  // a value the user just escaped out of).
  const settledRef = useRef(false);

  useEffect(() => {
    if (!editing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editing]);

  function start(): void {
    setValue(title);
    settledRef.current = false;
    setEditing(true);
  }

  async function commit(): Promise<void> {
    setEditing(false);
    const trimmed = value.trim();
    // Empty/whitespace → cancel, don't save. Unchanged → no-op.
    if (trimmed === '' || trimmed === title || busy) return;
    setBusy(true);
    try {
      await api.meetings.rename(id, trimmed);
      onRenamed();
    } finally {
      setBusy(false);
    }
  }

  if (!editing) {
    return (
      <button
        type="button"
        onClick={start}
        title="Click to rename"
        className="group max-w-full font-semibold truncate align-middle
                   hover:underline decoration-dotted underline-offset-4"
      >
        {title}
        <span aria-hidden className="ml-1.5 text-xs opacity-0 group-hover:opacity-40 transition-opacity">✎</span>
      </button>
    );
  }

  return (
    <input
      ref={inputRef}
      value={value}
      disabled={busy}
      maxLength={500}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          settledRef.current = true;
          void commit();
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          settledRef.current = true;
          setEditing(false);
        }
      }}
      onBlur={() => {
        if (settledRef.current) return;
        void commit();
      }}
      aria-label="Meeting title"
      className="w-full max-w-md text-center font-semibold bg-surface border border-brand-indigo/60
                 rounded-md px-2 py-0.5 focus:outline-none focus:ring-2 focus:ring-brand-indigo/30
                 disabled:opacity-60"
    />
  );
}

/** Layout-matching loading state. Paints the title bar, a static
 *  approximation of the StageTimeline (every chip in pending state),
 *  and skeleton bars in the center pane. Replaces the old double
 *  "Loading…" placeholder which felt like the app had frozen.
 *
 *  When a hint is provided (Library row click, search palette hit),
 *  we render the real title and — if pipelineStage is known —
 *  highlight the current stage chip so the user perceives this as
 *  "the page is here" not "we're starting from scratch." */
function DetailSkeleton({
  hint, onBack,
}: {
  hint?: { title?: string; pipelineStage?: string; status?: string };
  onBack: () => void;
}): JSX.Element {
  const stageIdx = hint?.pipelineStage ? stepIndexFor(hint.pipelineStage) : -1;
  const isFullyDone = hint?.pipelineStage === 'done';
  const showLiveStage = hint?.status === 'processing';
  return (
    <div className="max-w-6xl mx-auto my-6 bg-surface rounded-xl shadow-pop border border-surface-border overflow-hidden">
      {/* Title bar — uses real title when available */}
      <div className="flex items-center gap-3 px-5 py-3 border-b border-surface-border">
        <button onClick={onBack} className="text-ink-muted hover:text-ink text-sm shrink-0">
          ← Library
        </button>
        <div className="flex-1 min-w-0 text-center font-semibold truncate px-2">
          {hint?.title ?? (
            <span className="inline-block h-4 w-48 bg-skeleton/80 rounded animate-pulse align-middle" />
          )}
        </div>
        <div className="w-[68px]" />
      </div>

      {/* Stage timeline approximation */}
      <div className="flex items-center gap-1 px-5 py-3 border-b border-surface-border bg-surface-sunken overflow-x-auto">
        {USER_STEPS.map((step, i) => {
          const isDone = !isFullyDone && stageIdx > i;
          const isCurrent = !isFullyDone && stageIdx === i && showLiveStage;
          const isAllDone = isFullyDone;
          return (
            <div key={step} className="flex items-center gap-1 shrink-0">
              <div className={`
                flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold tabular-nums
                ${isAllDone || isDone ? 'bg-status-okBg/70 text-status-ok' : ''}
                ${isCurrent ? 'bg-brand-indigo text-white shadow-sm' : ''}
                ${!isCurrent && !isDone && !isAllDone ? 'bg-transparent text-ink-muted' : ''}
              `}>
                <span className={`w-1.5 h-1.5 rounded-full ${
                  isCurrent ? 'bg-white/70 animate-pulse'
                  : (isAllDone || isDone) ? 'bg-status-ok/40'
                  : 'bg-ink-muted/40'
                }`} />
                <span>{step}</span>
              </div>
              {i < USER_STEPS.length - 1 && (
                <div className={`w-3 h-px ${isAllDone || isDone ? 'bg-status-ok/40' : 'bg-surface-border'}`} />
              )}
            </div>
          );
        })}
      </div>

      {/* Three-column body — skeletons sized to match the real layout */}
      <div className="grid grid-cols-1 lg:grid-cols-[220px_minmax(0,1fr)_240px] min-h-[560px]">
        {/* Left rail */}
        <div className="order-2 lg:order-first border-r border-surface-border p-4 space-y-4 animate-pulse">
          <div className="space-y-1.5">
            <div className="h-2 w-12 bg-skeleton/70 rounded" />
            <div className="h-4 w-32 bg-skeleton/80 rounded" />
          </div>
          <div className="space-y-1.5">
            <div className="h-2 w-10 bg-skeleton/70 rounded" />
            <div className="h-3 w-24 bg-skeleton/80 rounded" />
          </div>
          <div className="space-y-1.5">
            <div className="h-2 w-14 bg-skeleton/70 rounded" />
            <div className="h-3 w-28 bg-skeleton/80 rounded" />
            <div className="h-3 w-20 bg-skeleton/80 rounded" />
          </div>
        </div>
        {/* Center pane */}
        <div className="order-1 lg:order-none p-6">
          <div className="flex gap-4 mb-6">
            <div className="h-3 w-16 bg-skeleton/70 rounded animate-pulse" />
            <div className="h-3 w-16 bg-skeleton/70 rounded animate-pulse" />
            <div className="h-3 w-16 bg-skeleton/70 rounded animate-pulse" />
          </div>
          <div className="space-y-2.5 animate-pulse">
            <div className="h-3 bg-skeleton/80 rounded w-[96%]" />
            <div className="h-3 bg-skeleton/80 rounded w-[90%]" />
            <div className="h-3 bg-skeleton/80 rounded w-[94%]" />
            <div className="h-3 bg-skeleton/80 rounded w-[40%] mb-3" />
            <div className="h-3 bg-skeleton/80 rounded w-[88%]" />
            <div className="h-3 bg-skeleton/80 rounded w-[92%]" />
            <div className="h-3 bg-skeleton/80 rounded w-[55%]" />
          </div>
        </div>
        {/* Right rail */}
        <div className="order-3 border-l border-surface-border p-4 space-y-3 animate-pulse">
          <div className="h-2 w-16 bg-skeleton/70 rounded" />
          <div className="h-9 w-full bg-skeleton/60 rounded-lg" />
          <div className="h-9 w-full bg-skeleton/60 rounded-lg" />
          <div className="h-9 w-full bg-skeleton/60 rounded-lg" />
        </div>
      </div>

      {/* Audio player placeholder */}
      <div className="sticky bottom-0 bg-surface-sunken border-t border-surface-border px-5 py-4">
        <div className="h-8 bg-skeleton/60 rounded-md animate-pulse" />
      </div>
    </div>
  );
}

// Combined banner + toggle for the speaker-ID gate. Two modes:
//
// 1. Parked at the gate (status='awaiting_user'): amber banner with prominent
//    Continue button + summary of how many voices remain unidentified. The
//    skip checkbox becomes a "skip and continue" shortcut in this state.
//
// 2. Anywhere before the gate (status='processing' or 'pending' and stage is
//    at or before identifying): a quiet, always-visible row with just the
//    skip checkbox, so the user can set-and-forget while transcription runs.
//    Transcription takes long enough that the user has plenty of time to
//    make the call before the gate is reached.
//
// Past the gate (summarizing/extracting/done) or on a failed meeting: render
// nothing. The decision is already behind us.
// The speaker-ID UI has two modes that want different placements:
//   parked (awaiting_speaker_id) — critical gate, renders ABOVE the
//     StageTimeline so the user doesn't have to scan past pipeline chips
//     to find the action. That's the whole point of the gate.
//   pre-gate — quiet skip-toggle row, renders below the timeline where
//     it's available but doesn't shout.
// Kept as one component with a `placement` prop so each call site asks
// for its own half — returns null for the other mode.
function SpeakerIdControls({
  meeting, onReload, placement,
}: {
  meeting: MeetingDetail;
  onReload: () => Promise<void>;
  placement: 'above-timeline' | 'below-timeline';
}): JSX.Element | null {
  const stage = meeting.pipelineStage;
  const parked = meeting.status === 'awaiting_user' && stage === 'awaiting_speaker_id';
  const preGate =
    stage === 'discovered' || stage === 'transcribing' || stage === 'diarizing' ||
    stage === 'merging' || stage === 'identifying';

  // Parked banner is the one moment in the pipeline that blocks on a human
  // decision. On a narrow viewport the banner can sit below the fold past
  // the back button and header — the user wonders why nothing's happening,
  // then scrolls and finds the CTA they were supposed to see immediately.
  // Centring it on first parked render keeps the gate from hiding.
  const bannerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (placement === 'above-timeline' && parked && bannerRef.current) {
      bannerRef.current.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }, [placement, parked]);

  if (placement === 'above-timeline' && !parked) return null;
  if (placement === 'below-timeline' && !preGate) return null;

  const unidentified = meeting.speakers.filter((s) => !s.rosterId).length;
  const totalSpeakers = meeting.speakers.length;

  async function setSkip(skip: boolean): Promise<void> {
    await api.meetings.setSkipSpeakerId(meeting.id, skip);
    await onReload();
  }
  async function continueNow(): Promise<void> {
    await api.meetings.continueFromSpeakerId(meeting.id);
    await onReload();
  }

  if (parked) {
    return (
      <div ref={bannerRef} className="px-5 py-4 border-b border-surface-border bg-status-warnBg flex items-center gap-4">
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-status-warnText text-sm">
            Paused — name your speakers before summarize runs
          </div>
          <div className="text-xs text-status-warnText/80 mt-0.5">
            {totalSpeakers === 0
              ? 'No speakers detected yet.'
              : unidentified === 0
                ? `All ${totalSpeakers} voices identified. Click Continue to finish processing.`
                : `${unidentified} of ${totalSpeakers} voices still unidentified. Use the Speakers panel on the right to label them, then Continue.`}
          </div>
        </div>
        <label className="flex items-center gap-2 text-xs text-status-warnText cursor-pointer select-none">
          <input
            type="checkbox"
            checked={meeting.skipSpeakerId}
            onChange={(e) => void setSkip(e.target.checked)}
            className="w-3.5 h-3.5 accent-status-warn"
          />
          Skip for this meeting
        </label>
        <button
          onClick={() => void continueNow()}
          className="text-sm font-semibold bg-status-warn hover:opacity-90 text-white px-4 py-1.5 rounded-lg shadow-sm transition"
        >
          Continue →
        </button>
      </div>
    );
  }

  // Pre-gate: quiet skip toggle only. No banner text, just a one-line row
  // so the user notices it exists without it feeling like a warning.
  return (
    <div className="px-5 py-2 border-b border-surface-border bg-surface-sunken/50 flex items-center justify-end gap-2 text-xs text-ink-muted">
      <label className="flex items-center gap-2 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={meeting.skipSpeakerId}
          onChange={(e) => void setSkip(e.target.checked)}
          className="w-3.5 h-3.5 accent-brand-indigo"
        />
        Skip speaker ID step — don&apos;t pause pipeline for this meeting
      </label>
    </div>
  );
}

// Shown only when status==='failed'. On failure the pipeline leaves the stage
// at a safe re-entry point (the failed stage itself for sequential stages, or
// a rollback to 'discovered' for the parallel transcribe/diarize block), so
// Retry re-runs from there via api.meetings.rerun — which clears stale
// artifacts before re-enqueuing; updateStatus clears the stored error so the
// banner disappears once the retry starts.
function FailureBanner({
  meeting, onReload,
}: {
  meeting: MeetingDetail;
  onReload: () => Promise<void>;
}): JSX.Element | null {
  const [retrying, setRetrying] = useState(false);
  if (meeting.status !== 'failed') return null;

  const failedStep = USER_STEPS[stepIndexFor(meeting.pipelineStage)] ?? null;

  // Gate the inline recovery controls on the reasoning-runaway failure
  // signature so they only appear for the failure they actually fix, not
  // every unrelated error. Marker parity with the main-process client is
  // test-enforced (lib/reasoning-loop.test.ts).
  const isReasoningLoopFailure = (meeting.errorMessage ?? '').includes(REASONING_LOOP_MARKER);

  async function retry(): Promise<void> {
    if (retrying) return;
    setRetrying(true);
    try {
      // Retry from wherever the pipeline left us on failure, via the same
      // primitive the left rail's "Re-run pipeline from…" buttons use.
      // meeting.pipelineStage is the failed stage for sequential stages, or
      // the rolled-back re-entry point ('discovered') for the parallel
      // transcribe/diarize block. Unlike api.meetings.start(), rerun() clears
      // any stale artifacts/action-items/speaker-links left behind by the
      // failed attempt before re-enqueuing.
      await api.meetings.rerun(meeting.id, meeting.pipelineStage);
      await onReload(); // bumps the poll loop; status flips to 'processing'
    } finally {
      setRetrying(false);
    }
  }

  return (
    <div className="px-5 py-4 border-b border-surface-border bg-danger-bg flex items-start gap-4">
      <div className="flex-1 min-w-0">
        <div className="font-semibold text-danger-text text-sm">
          Processing failed{failedStep ? ` during ${failedStep}` : ''}
        </div>
        {meeting.errorMessage ? (
          <pre className="mt-1.5 text-xs text-danger-text/90 bg-danger-bg/60 border border-danger-border rounded-md px-2.5 py-1.5 max-h-28 overflow-auto whitespace-pre-wrap font-mono">
            {meeting.errorMessage}
          </pre>
        ) : (
          <div className="text-xs text-danger-text/80 mt-0.5">
            No error detail was recorded. Check the logs in Settings → Diagnostics.
          </div>
        )}
        {isReasoningLoopFailure && <ReasoningRecoveryControls />}
      </div>
      <button
        onClick={() => void retry()}
        disabled={retrying}
        className="shrink-0 text-sm font-semibold bg-danger-solid hover:bg-danger-solid disabled:opacity-60 text-white px-4 py-1.5 rounded-lg shadow-sm transition"
      >
        {retrying ? 'Retrying…' : 'Retry ↻'}
      </button>
    </div>
  );
}

/** Lets the user fix a reasoning-model loop failure without leaving the
 *  meeting to visit Settings. Changing either field here updates the same
 *  global settings Settings would — this is a shortcut to that existing
 *  state, not a new per-run override concept — so the change also applies
 *  to future meetings until changed again. */
function ReasoningRecoveryControls(): JSX.Element {
  const [models, setModels] = useState<string[]>([]);
  const [llmModel, setLlmModel] = useState('');
  const [disableThinking, setDisableThinking] = useState(true);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    void Promise.all([api.models.list(), api.settings.getAll()]).then(([m, settings]) => {
      if (!alive) return;
      const modelList = m as string[];
      const current = settings as { llmModel: string; disableThinking: boolean };
      setModels(modelList);
      setLlmModel(current.llmModel);
      setDisableThinking(current.disableThinking);
      setLoaded(true);
    });
    return () => { alive = false; };
  }, []);

  async function changeModel(next: string): Promise<void> {
    setLlmModel(next);
    await api.settings.set('llmModel', next);
  }

  async function changeDisableThinking(next: boolean): Promise<void> {
    setDisableThinking(next);
    await api.settings.set('disableThinking', next);
  }

  if (!loaded) {
    return <div className="text-xs text-danger-text/70 mt-2 italic">Loading recovery options…</div>;
  }

  return (
    <div className="mt-3 pt-3 border-t border-danger-border/60 space-y-2">
      <div className="text-xs font-semibold text-danger-text">
        This looks like a reasoning-model loop. Fix it here, then hit Retry:
      </div>
      <select
        value={llmModel}
        onChange={(e) => void changeModel(e.target.value)}
        className="input text-xs"
      >
        <option value="">(choose)</option>
        {models.map((m) => (
          <option key={m} value={m}>{isKnownReasoningModel(m) ? `${m} (reasoning)` : m}</option>
        ))}
      </select>
      <label className="flex items-center gap-2 text-xs text-danger-text cursor-pointer">
        <input
          type="checkbox"
          checked={disableThinking}
          onChange={(e) => void changeDisableThinking(e.target.checked)}
        />
        Disable model thinking
      </label>
    </div>
  );
}

function StageTimeline({ meeting }: { meeting: MeetingDetail }): JSX.Element {
  // Three visual states per step: done (check), current (spinner or X), pending.
  // - pipelineStage='done' => every step is done (full row of checkmarks,
  //   so you can see "yes, it ran the whole pipeline").
  // - status='processing'  => steps before currentIdx are done, currentIdx is
  //   the live spinner with elapsed time, rest are pending.
  // - status='failed'      => steps before currentIdx are done, currentIdx is
  //   a red X (this is where it died), rest are pending.
  // The user-facing step model is shared with LibraryRow so the row's
  // "PROCESSING N/<total>" matches the position highlighted here.
  const isFullyDone = meeting.pipelineStage === 'done';
  const rawIdx = stepIndexFor(meeting.pipelineStage);
  const currentIdx = isFullyDone ? USER_STEPS.length : rawIdx;
  const elapsed = useElapsed(meeting.stageStartedAt, meeting.status === 'processing');
  const isFailed = meeting.status === 'failed';
  const isProcessing = meeting.status === 'processing';
  const isAwaiting = meeting.status === 'awaiting_user';

  return (
    <div className="flex items-center gap-1 px-5 py-3 border-b border-surface-border bg-surface-sunken overflow-x-auto">
      {USER_STEPS.map((step, i) => {
        const isDone = currentIdx > i;
        const isCurrent = !isFullyDone && currentIdx === i;
        const isPending = currentIdx < i;
        const isFailedHere = isCurrent && isFailed;
        const isAwaitingHere = isCurrent && isAwaiting;
        return (
          <div key={step} className="flex items-center gap-1 shrink-0">
            <div
              className={`
                flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold tabular-nums
                ${isDone ? 'bg-status-okBg/70 text-status-ok' : ''}
                ${isCurrent && isProcessing ? 'bg-brand-indigo text-white shadow-sm' : ''}
                ${isFailedHere ? 'bg-danger-bg text-danger-text' : ''}
                ${isAwaitingHere ? 'bg-status-warnBg text-status-warnText shadow-sm' : ''}
                ${isPending ? 'bg-transparent text-ink-muted' : ''}
              `}
            >
              {isDone && <CheckMark />}
              {isCurrent && isProcessing && <MiniSpinner />}
              {isFailedHere && <XMark />}
              {isAwaitingHere && <PauseMark />}
              {isPending && <EmptyDot />}
              <span>{step}</span>
              {isCurrent && isProcessing && elapsed !== null && (
                <span className="font-normal opacity-80">
                  {fmtElapsed(elapsed)}
                  {' · '}
                  <span className={isRunningLong(elapsed, meeting.stageEtaMs) ? 'text-status-warnText font-semibold' : ''}>
                    {fmtEta(meeting.stageEtaMs, meeting.stageEtaRough)}
                    {isRunningLong(elapsed, meeting.stageEtaMs) ? ' · running long' : ''}
                  </span>
                </span>
              )}
              {/* No "waiting" word — the pause icon + amber color already say it.
                  Adding the word made the chip wrap to two lines on narrow widths. */}
            </div>
            {i < USER_STEPS.length - 1 && (
              <div className={`w-3 h-px ${isDone ? 'bg-status-ok/40' : 'bg-surface-border'}`} />
            )}
          </div>
        );
      })}
    </div>
  );
}

// Timeline icons are deliberately at 14px (w-3.5 h-3.5) with thick
// strokes — 12px was glanceable for sighted users but too small to do
// the work of conveying state on its own for users who can't read the
// chip's color (red/green color-blindness, sun glare, etc.). At 14px
// the icon shape (✓ / ✕ / ⏸ / spinner) is identifiable at a meter's
// distance from the screen, regardless of color.
function XMark(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}

function CheckMark(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 8l3.5 3.5L13 5" />
    </svg>
  );
}

function MiniSpinner(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" className="w-3.5 h-3.5 animate-spin" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
      <path d="M8 2a6 6 0 1 1-6 6" opacity="0.9" />
    </svg>
  );
}

function EmptyDot(): JSX.Element {
  return <span className="w-1.5 h-1.5 rounded-full bg-ink-muted/40" />;
}

function PauseMark(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" className="w-3.5 h-3.5" fill="currentColor">
      <rect x="4" y="3" width="2.5" height="10" rx="0.5" />
      <rect x="9.5" y="3" width="2.5" height="10" rx="0.5" />
    </svg>
  );
}

function LeftRail({
  meeting, onReload,
}: {
  meeting: MeetingDetail;
  onReload: () => Promise<void>;
}): JSX.Element {
  async function startProcessing(): Promise<void> {
    await api.meetings.start(meeting.id);
    await onReload();
  }
  async function rerunFrom(stage: string): Promise<void> {
    await api.meetings.rerun(meeting.id, stage);
    await onReload();
  }

  // "Never been processed" = still sitting in the Inbox. The appropriate
  // control here is Process, not Re-run. Re-run only makes sense once there's
  // something to re-do (i.e. the pipeline has at least started).
  const neverProcessed =
    meeting.pipelineStage === 'discovered' && meeting.status === 'pending';
  const isProcessing = meeting.status === 'processing';

  // Field labels in the left rail (`Title`, `Date`, `Models`) use a
  // quieter sans-serif treatment than the tracked-monospace section
  // headers (`SPEAKERS`, `EXPORT`, `RE-RUN PIPELINE FROM…`). Earlier
  // both used the same treatment, which collapsed the hierarchy and
  // made every label fight for attention. Now: tracked-mono for
  // section headers, plain small caps for fields.
  return (
    <div className="border-r border-surface-border p-4 space-y-3">
      <div>
        <div className="text-[11px] text-ink-muted font-medium">Title</div>
        <div className="font-semibold">{meeting.title}</div>
      </div>
      <div>
        <div className="text-[11px] text-ink-muted font-medium">Date</div>
        <div className="text-sm">{meeting.startedAt?.slice(0, 10) ?? '—'}</div>
      </div>
      <div>
        <div className="text-[11px] text-ink-muted font-medium">Models</div>
        {meeting.models.stt && <div className="text-xs">STT: {meeting.models.stt}</div>}
        {meeting.models.llm && <div className="text-xs">LLM: {meeting.models.llm}</div>}
      </div>
      <div className="pt-3 border-t border-surface-border">
        {neverProcessed ? (
          <button
            onClick={startProcessing}
            className="w-full bg-brand-indigo text-white text-sm font-semibold rounded-lg py-2 hover:bg-brand-indigo/90 transition inline-flex items-center justify-center gap-1.5"
          >
            <Icon name="play" className="w-3.5 h-3.5" />
            Process recording
          </button>
        ) : isProcessing ? (
          <div className="text-xs text-ink-muted italic px-1">
            Processing in progress — re-run options will be available once it
            finishes or fails.
          </div>
        ) : (
          <div className="space-y-2">
            <div className="font-mono text-[11px] tracking-[0.2em] uppercase text-ink-muted font-semibold mb-1">Re-run pipeline from…</div>
            {([
              ['transcribing', 'transcribe + everything after'],
              ['diarizing', 'diarize + everything after'],
              ['summarizing', 'just summary + actions'],
            ] as const).map(([stage, label]) => (
              <button
                key={stage}
                onClick={() => rerunFrom(stage)}
                className="group w-full text-left bg-surface border-l-2 border-l-brand-indigo/40 border border-surface-border rounded-lg py-2 px-3 text-[13px] text-ink-soft transition-all duration-150 hover:border-l-brand-indigo hover:bg-brand-indigo/5 hover:text-brand-indigo hover:shadow-sm"
                title={label}
              >
                <span className="inline-block transition-transform duration-200 group-hover:rotate-[-45deg] mr-1.5">↻</span>
                {label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ArtifactFeedback({ label, state, onRetry }: {
  label: string;
  state: DetailArtifactState<unknown>;
  onRetry: () => void;
}): JSX.Element | null {
  if (state.error) return (
    <div role="alert" className="mb-2 flex items-center gap-2 text-xs text-danger">
      <span className="min-w-0">Could not load {label}: {state.error}</span>
      <button type="button" onClick={onRetry} disabled={state.loading}
        className="shrink-0 font-semibold underline disabled:opacity-40">Retry</button>
    </div>
  );
  if (state.loading && state.data === undefined) return (
    <div role="status" className="mb-2 flex items-center gap-1.5 text-xs text-ink-muted">
      <MiniSpinner /> Loading {label}…
    </div>
  );
  return null;
}

function CenterPane({
  meeting, tab, onTab, currentTime, onSeek, onReload, onShowSource, provenance,
  summaryMode, onSummaryMode, summaryDraft, onSummaryDraft, summarySaved, onSummaryBaseline,
  transcriptState, onRetryTranscript,
}: {
  meeting: MeetingDetail;
  tab: Tab;
  onTab: (t: Tab) => void;
  currentTime: number;
  onSeek: (seconds: number) => void;
  onReload: () => Promise<void>;
  onShowSource: (quote: string) => void;
  provenance: { quote: string; nonce: number } | null;
  /** Lifted summary edit session (owned by the view root so tab
   *  switches don't discard it) — see the state block up there. */
  summaryMode: SummaryMode;
  onSummaryMode: (m: SummaryMode) => void;
  summaryDraft: string;
  onSummaryDraft: (v: string) => void;
  summarySaved: string;
  onSummaryBaseline: (v: string) => void;
  transcriptState: DetailArtifactState<unknown>;
  onRetryTranscript: () => void;
}): JSX.Element {
  const showRaw = meeting.transcriptMd === null && meeting.rawTranscriptText !== null;
  return (
    <div>
      {/* Tab labels share the ALL-CAPS tracked treatment used by the
          Library/Inbox section headings, so section-level typography is
          consistent across views. Audio is now a sticky footer, not a
          tab — keeps playback alive while reading either tab.
          Sticky-pinned to the top of the center-pane scroll container
          so SUMMARY/TRANSCRIPT/ACTIONS stay reachable while paging
          through a long summary or transcript. */}
      <div className="sticky top-0 z-10 bg-surface flex border-b border-surface-border px-4">
        {(['summary', 'transcript', 'actions'] as const).map((t) => (
          <button
            key={t}
            onClick={() => onTab(t)}
            className={`px-3 py-3 font-mono text-[11px] tracking-[0.2em] uppercase transition
              ${tab === t
                ? 'text-brand-indigo border-b-2 border-brand-indigo font-semibold -mb-px'
                : 'text-ink-muted hover:text-ink'}`}
          >
            {t}
          </button>
        ))}
      </div>
      <div className="p-5">
        {tab === 'summary' && (
          <SummaryPanel
            meeting={meeting}
            onReload={onReload}
            provenance={provenance}
            mode={summaryMode}
            onMode={onSummaryMode}
            draft={summaryDraft}
            onDraft={onSummaryDraft}
            savedValue={summarySaved}
            onBaseline={onSummaryBaseline}
          />
        )}
        {tab === 'transcript' && (
          <>
            <ArtifactFeedback label="transcript" state={transcriptState} onRetry={onRetryTranscript} />
            {transcriptState.data !== undefined && <TranscriptPanel
              meeting={meeting}
              showRaw={showRaw}
              currentTime={currentTime}
              onSeek={onSeek}
            />}
          </>
        )}
        {tab === 'actions' && <ActionItemsPanel meeting={meeting} onReload={onReload} onShowSource={onShowSource} />}
      </div>
    </div>
  );
}

// Click-to-seek transcript (#42). Each parsed line becomes a button that
// calls onSeek. A timeupdate-driven currentTime highlights the line
// covering that second. Falls back to plain-text rendering for raw
// pre-merge transcripts (no speaker prefixes to parse).
//
// Two view modes (toggle in the header):
//   - Per-line: every timestamped row gets its own clickable line.
//     Closest to the on-disk transcript.md, finest-grained seek.
//   - Grouped: consecutive same-speaker lines are collapsed into one
//     paragraph, so a 30-line monologue reads as a paragraph instead
//     of 30 timestamped fragments. Click anywhere in a group to seek
//     to its start.
//
// The user's choice is persisted to localStorage so it survives view
// navigation; defaults to per-line for backward compatibility with
// users who already know that layout.

// Inline-editable list of action items (#44). Click a row → expands to
// text / owner / due-date inputs. Add-item row at the bottom. Delete is
// hard-delete (no undo — users can retype if they change their mind).

// ─── Summary panel ─────────────────────────────────────────────────────────
//
// Two modes for the LLM-generated summary:
//   view — rendered markdown only
//   edit — textarea + live preview side-by-side
// The previous third mode (full-width textarea, no preview) overlapped with
// edit's editor pane and added decision-fatigue without unique value.
// Anyone wanting more horizontal room can resize the window.
//
// The user owns the final text — the summarize stage gives a starting draft,
// but cleanup is almost always needed (model hallucinations, formatting
// tweaks, redactions). Saved markdown is written straight to summary.md on
// disk; the next pipeline run that touches summarize will overwrite, so
// users wanting to preserve edits across re-runs should avoid re-summarizing.
//
// Edits are kept in LIFTED state (the view root owns draft/mode/baseline —
// this panel unmounts on every tab switch, so keeping the session here
// used to silently discard edits) and only persisted on Save. Disk writes
// happen via the meetings:save-summary IPC, NOT via re-running the pipeline.
type SummaryMode = 'view' | 'edit';

function SummaryPanel({
  meeting, onReload, provenance, mode, onMode, draft, onDraft, savedValue, onBaseline,
}: {
  meeting: MeetingDetail;
  onReload: () => Promise<void>;
  provenance: { quote: string; nonce: number } | null;
  mode: SummaryMode;
  onMode: (m: SummaryMode) => void;
  draft: string;
  onDraft: (v: string) => void;
  /** The local "what's on disk" baseline. Advances via onBaseline on a
   *  successful save, ahead of `meeting.summaryMd` catching up to the
   *  reload — so dirty (and the view) reflect the just-saved content. */
  savedValue: string;
  onBaseline: (v: string) => void;
}): JSX.Element {
  const original = meeting.summaryMd ?? '';
  // Transient save-cycle state can stay local: losing "Saving…" / the
  // ✓-saved timestamp / an error banner on a tab switch is harmless.
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty = draft !== savedValue;

  async function save(): Promise<void> {
    if (!dirty || saving) return;
    setSaving(true); setError(null);
    try {
      await api.meetings.saveSummary(meeting.id, draft);
      onBaseline(draft);
      setSavedAt(new Date());
      // After a successful save, drop back into view so the rendered
      // markdown reflects what's now on disk.
      onMode('view');
      // Refresh the parent so other panes keying off `meeting.summaryMd`
      // (e.g. RightRail's "has summary" check) see the new content.
      void onReload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  if (!original && !dirty) {
    return <Placeholder text="Summary will appear after the summarize stage." />;
  }

  return (
    <div className="flex flex-col gap-3">
      <SummaryToolbar
        mode={mode}
        onMode={onMode}
        dirty={dirty}
        saving={saving}
        savedAt={savedAt}
        error={error}
        onSave={save}
        onRevert={() => { onDraft(savedValue); setError(null); }}
      />
      {mode === 'view' && <MarkdownPreview source={draft} highlight={provenance} />}
      {mode === 'edit' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <MarkdownEditor value={draft} onChange={onDraft} />
          <div className="border border-surface-border rounded-lg p-4 bg-surface-sunken/40 overflow-auto max-h-[60vh]">
            <MarkdownPreview source={draft} />
          </div>
        </div>
      )}
    </div>
  );
}

function SummaryToolbar({
  mode, onMode, dirty, saving, savedAt, error, onSave, onRevert,
}: {
  mode: SummaryMode;
  onMode: (m: SummaryMode) => void;
  dirty: boolean;
  saving: boolean;
  savedAt: Date | null;
  error: string | null;
  onSave: () => Promise<void> | void;
  onRevert: () => void;
}): JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <div className="inline-flex bg-surface-sunken rounded-lg p-0.5 text-xs font-semibold">
        {(['view', 'edit'] as const).map((m) => (
          <button
            key={m}
            onClick={() => onMode(m)}
            className={`px-2.5 py-1 rounded-md transition-colors ${
              mode === m ? 'bg-surface text-ink shadow-sm' : 'text-ink-muted hover:text-ink'
            }`}
          >
            {m === 'view' ? 'View' : 'Edit'}
          </button>
        ))}
      </div>
      <div className="flex-1 min-w-0">
        {error && <span className="text-xs text-danger truncate" title={error}>{error}</span>}
        {!error && dirty && <span className="text-xs text-ink-muted">Unsaved changes</span>}
        {!error && !dirty && savedAt && (
          <span className="text-xs text-status-ok">
            ✓ Saved {savedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </span>
        )}
      </div>
      {dirty && (
        <button
          onClick={onRevert}
          className="text-xs text-ink-muted hover:text-ink px-2 py-1 rounded hover:bg-surface-sunken"
        >
          Revert
        </button>
      )}
      <button
        onClick={() => void onSave()}
        disabled={!dirty || saving}
        className="text-xs font-semibold bg-brand-indigo text-white px-3 py-1 rounded-md
                   hover:bg-brand-indigo/90 disabled:opacity-40 disabled:cursor-not-allowed transition"
      >
        {saving ? 'Saving…' : 'Save'}
      </button>
    </div>
  );
}

function MarkdownPreview({
  source, highlight,
}: {
  source: string;
  highlight?: { quote: string; nonce: number } | null;
}): JSX.Element {
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Normalize the way we compare item-source text to rendered markdown text:
  // markdown may render "—" / smart quotes differently than the on-disk
  // bullet, and whitespace collapses. Lowercase + strip non-alphanumerics so
  // "Ship the v2 API — Dan" matches the rendered "Ship the v2 API — Dan".
  const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

  useEffect(() => {
    const root = rootRef.current;
    if (!root || !highlight?.quote) return;
    const target = norm(highlight.quote);
    if (!target) return;
    // Search list items first (action items are bullets), then paragraphs.
    const nodes = Array.from(root.querySelectorAll('li, p')) as HTMLElement[];
    const hit = nodes.find((n) => norm(n.textContent ?? '').includes(target));
    if (!hit) return;
    hit.classList.add('provenance-flash');
    hit.scrollIntoView({ block: 'center', behavior: 'smooth' });
    const t = setTimeout(() => hit.classList.remove('provenance-flash'), 2600);
    return () => clearTimeout(t);
    // `nonce` in the dep list re-runs this when the same item is clicked twice.
  }, [highlight?.quote, highlight?.nonce]);

  // Parsing markdown is the expensive part (a long summary/transcript runs
  // tens of ms). Memoize the element on `source` so re-renders that don't
  // change the text — provenance-highlight clicks, the 2s meeting poll while
  // processing, any parent state churn — reuse the previous element and React
  // bails out of the subtree instead of re-parsing.
  const rendered = useMemo(
    () => <ReactMarkdown remarkPlugins={[remarkGfm]}>{source}</ReactMarkdown>,
    [source],
  );

  // `prose` gives us reasonable defaults for headings, lists, code blocks,
  // tables (via remark-gfm), and links — without us having to hand-style
  // every element. `whitespace-pre-wrap` is intentionally absent: the
  // markdown renderer handles its own line breaks via paragraph splitting.
  return (
    <div ref={rootRef} className="prose prose-sm max-w-none prose-headings:mt-3 prose-p:my-2">
      {rendered}
    </div>
  );
}

function MarkdownEditor({
  value, onChange,
}: { value: string; onChange: (v: string) => void }): JSX.Element {
  // Simple textarea — no codemirror / monaco. Keeps the bundle slim and the
  // editing experience predictable. Tab key inserts two spaces (otherwise
  // it'd shift focus away, which is awful in a long edit).
  const ref = useRef<HTMLTextAreaElement>(null);
  // Track line count so we can grow the textarea proportionally without
  // clipping; capped at 60vh so the toolbar stays visible.
  const lineCount = useMemo(() => Math.max(8, value.split('\n').length + 2), [value]);
  return (
    <textarea
      ref={ref}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Tab') {
          e.preventDefault();
          const ta = e.currentTarget;
          const { selectionStart: ss, selectionEnd: se, value: v } = ta;
          const next = `${v.slice(0, ss)}  ${v.slice(se)}`;
          onChange(next);
          // Restore caret after React rerenders.
          requestAnimationFrame(() => {
            ta.selectionStart = ta.selectionEnd = ss + 2;
          });
        }
      }}
      spellCheck
      className="w-full font-mono text-[13px] leading-relaxed text-ink bg-surface-sunken/40
                 border border-surface-border rounded-lg p-3 resize-none
                 focus:outline-none focus:ring-2 focus:ring-brand-indigo/40 focus:border-brand-indigo
                 max-h-[60vh] overflow-auto"
      style={{ minHeight: `${Math.min(lineCount, 30) * 1.5}rem` }}
    />
  );
}

function RightRail({ meeting, onReload, speakerReviewState, onRetrySpeakerReview }: {
  meeting: MeetingDetail;
  onReload: () => Promise<void>;
  speakerReviewState: DetailArtifactState<unknown>;
  onRetrySpeakerReview: () => void;
}): JSX.Element {
  return <div className="border-l border-surface-border p-4 space-y-3">
    <ArtifactFeedback label="speaker review" state={speakerReviewState} onRetry={onRetrySpeakerReview} />
    <SpeakersPanel meeting={meeting} onReload={onReload} />
    <MeetingExportPanel meeting={meeting} onReload={onReload} />
  </div>;
}
