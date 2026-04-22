// electron/renderer/src/views/MeetingDetailView.tsx
import { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api } from '../ipc/client';
import { useElapsed, fmtElapsed } from '../lib/useElapsed';
import { colorForSpeakerIndex } from '../theme/tokens';
import { MeetingRowMenu } from '../components/MeetingRowMenu';

type Tab = 'summary' | 'transcript' | 'audio';

interface MeetingDetail {
  id: string;
  title: string;
  startedAt: string | null;
  durationS: number | null;
  pipelineStage: string;
  status: string;
  stageStartedAt: string | null;
  skipSpeakerId: boolean;
  transcriptMd: string | null;
  rawTranscriptText: string | null;
  summaryMd: string | null;
  audioPath: string;
  speakers: { localLabel: string; rosterId: string | null; displayName: string | null }[];
  actionItems: {
    id: string;
    text: string;
    ownerName: string | null;
    dueDate: string | null;
    status: string;
    exportedTo: string[];
  }[];
  models: { stt?: string; llm?: string };
}

const PIPELINE_STAGES = [
  'transcribing', 'diarizing', 'merging', 'identifying',
  'awaiting_speaker_id',
  'summarizing', 'extracting',
] as const;
type PipelineStage = (typeof PIPELINE_STAGES)[number];
const STAGE_LABELS: Record<PipelineStage, string> = {
  transcribing: 'transcribe',
  diarizing: 'diarize',
  merging: 'merge',
  identifying: 'identify',
  awaiting_speaker_id: 'name voices',
  summarizing: 'summarize',
  extracting: 'extract',
};

export function MeetingDetailView({ id, onBack }: { id: string; onBack: () => void }): JSX.Element {
  const [m, setM] = useState<MeetingDetail | null>(null);
  const [tab, setTab] = useState<Tab>('summary');

  // `kick` is a deliberate re-run trigger for the polling effect. Mutations
  // that change the meeting's live state (rerun, speaker assign) bump it so
  // the effect tears down its old timer and starts fresh — polling resumes
  // even after the meeting had already settled at 'done'.
  const [kick, setKick] = useState(0);
  const reload = async (): Promise<void> => {
    setKick((k) => k + 1);
  };

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    async function load(): Promise<void> {
      const d = (await api.meetings.get(id)) as MeetingDetail;
      if (!alive) return;
      setM(d);
      // Poll while anything is in flight. A rerun puts the meeting back into
      // 'processing', which re-enters this branch via the `kick` dependency.
      if (d.status === 'processing') {
        timer = setTimeout(load, 2000);
      }
    }
    void load();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [id, kick]);

  if (!m)
    return (
      <div className="max-w-6xl mx-auto my-6 bg-surface rounded-xl shadow-pop border border-surface-border overflow-hidden">
        <div className="flex items-center gap-3 px-5 py-3 border-b border-surface-border">
          <button onClick={onBack} className="text-ink-muted hover:text-ink text-sm">
            ← Library
          </button>
          <div className="flex-1 text-center font-semibold text-ink-muted">Loading…</div>
          <div className="w-[68px]" />
        </div>
        <div className="p-8 text-ink-muted">Loading…</div>
      </div>
    );

  return (
    <div className="max-w-6xl mx-auto my-6 bg-surface rounded-xl shadow-pop border border-surface-border overflow-hidden">
      <div className="flex items-center gap-3 px-5 py-3 border-b border-surface-border">
        <button onClick={onBack} className="text-ink-muted hover:text-ink text-sm shrink-0">
          ← Library
        </button>
        {/* min-w-0 lets the truncate actually clip long titles instead of
            forcing the flex row to overflow — otherwise a long title would
            push the actions menu off the right edge. */}
        <div className="flex-1 min-w-0 text-center font-semibold truncate px-2">{m.title}</div>
        {/* Actions menu: rename/delete from the detail view. When the user
            deletes from here, route back to Library since the detail we're
            viewing no longer exists. */}
        <div className="relative w-[68px] flex justify-end shrink-0">
          <MeetingRowMenu
            meeting={{ id: m.id, title: m.title }}
            onChanged={() => void reload()}
            onDeleted={() => onBack()}
          />
        </div>
      </div>

      {/* Parked-at-gate banner renders ABOVE the timeline. The gate is the
          one moment in the pipeline where the UI is waiting for a human
          decision; hiding it below 8 pipeline chips hurt the time-to-
          action. Returns null when not parked. */}
      <SpeakerIdControls meeting={m} onReload={reload} placement="above-timeline" />

      {/* The timeline is the canonical "where is this meeting in the pipeline"
          display. Always rendered — for never-processed meetings every stage
          is pending, while processing the current stage spins, after
          completion it's a persistent point-in-time record, and after a
          rerun kick the stages downstream of the rerun point flip back to
          pending so the progress is visible as it happens again. */}
      <StageTimeline meeting={m} />

      {/* Quiet pre-gate skip-toggle row. Returns null when parked — the
          parked banner above already exposes the same control. */}
      <SpeakerIdControls meeting={m} onReload={reload} placement="below-timeline" />

      {/* Responsive layout: stack single-column below lg (1024px) so the
          narrow rails don't clip center-pane content (transcript / audio
          player / summary). min-w-0 on each cell lets flex/grid children
          actually shrink — without it long lines of text force horizontal
          overflow and the whole detail view gets cut off on the right.
          On narrow, the CenterPane renders first (content first), then
          LeftRail and RightRail below, so users aren't scrolling past
          sidebar meta to reach the transcript. On lg+ the grid
          columns-order lands them back in their natural visual order. */}
      <div className="grid grid-cols-1 lg:grid-cols-[220px_minmax(0,1fr)_240px] min-h-[560px]">
        <div className="order-1 lg:order-none min-w-0"><CenterPane meeting={m} tab={tab} onTab={setTab} /></div>
        <div className="order-2 lg:order-first min-w-0"><LeftRail meeting={m} onReload={reload} /></div>
        <div className="order-3 min-w-0"><RightRail meeting={m} onReload={reload} /></div>
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
      <div className="px-5 py-4 border-b border-surface-border bg-amber-50 flex items-center gap-4">
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-amber-900 text-sm">
            Paused — name your speakers before summarize runs
          </div>
          <div className="text-xs text-amber-900/80 mt-0.5">
            {totalSpeakers === 0
              ? 'No speakers detected yet.'
              : unidentified === 0
                ? `All ${totalSpeakers} voices identified. Click Continue to finish processing.`
                : `${unidentified} of ${totalSpeakers} voices still unidentified. Use the Speakers panel on the right to label them, then Continue.`}
          </div>
        </div>
        <label className="flex items-center gap-2 text-xs text-amber-900 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={meeting.skipSpeakerId}
            onChange={(e) => void setSkip(e.target.checked)}
            className="w-3.5 h-3.5 accent-amber-700"
          />
          Skip for this meeting
        </label>
        <button
          onClick={() => void continueNow()}
          className="text-sm font-semibold bg-amber-600 hover:bg-amber-700 text-white px-4 py-1.5 rounded-lg shadow-sm transition"
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

function StageTimeline({ meeting }: { meeting: MeetingDetail }): JSX.Element {
  // Three visual states per stage: done (check), current (spinner or X), pending.
  // - pipelineStage='done' => every stage is done (full row of checkmarks,
  //   so you can see "yes, it ran the whole pipeline").
  // - status='processing'  => stages before currentIdx are done, currentIdx is
  //   the live spinner with elapsed time, rest are pending.
  // - status='failed'      => stages before currentIdx are done, currentIdx is
  //   a red X (this is where it died), rest are pending.
  const isFullyDone = meeting.pipelineStage === 'done';
  const rawIdx = PIPELINE_STAGES.indexOf(meeting.pipelineStage as PipelineStage);
  const currentIdx = isFullyDone ? PIPELINE_STAGES.length : rawIdx;
  const elapsed = useElapsed(meeting.stageStartedAt, meeting.status === 'processing');
  const isFailed = meeting.status === 'failed';
  const isProcessing = meeting.status === 'processing';
  const isAwaiting = meeting.status === 'awaiting_user';

  return (
    <div className="flex items-center gap-1 px-5 py-3 border-b border-surface-border bg-surface-sunken overflow-x-auto">
      {PIPELINE_STAGES.map((stage, i) => {
        const isDone = currentIdx > i;
        const isCurrent = !isFullyDone && currentIdx === i;
        const isPending = currentIdx < i;
        const isFailedHere = isCurrent && isFailed;
        const isAwaitingHere = isCurrent && isAwaiting;
        return (
          <div key={stage} className="flex items-center gap-1 shrink-0">
            <div
              className={`
                flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold tabular-nums
                ${isDone ? 'bg-status-okBg/70 text-status-ok' : ''}
                ${isCurrent && isProcessing ? 'bg-brand-indigo text-white shadow-sm' : ''}
                ${isFailedHere ? 'bg-rose-100 text-rose-700' : ''}
                ${isAwaitingHere ? 'bg-amber-200 text-amber-900 shadow-sm' : ''}
                ${isPending ? 'bg-transparent text-ink-muted' : ''}
              `}
            >
              {isDone && <CheckMark />}
              {isCurrent && isProcessing && <MiniSpinner />}
              {isFailedHere && <XMark />}
              {isAwaitingHere && <PauseMark />}
              {isPending && <EmptyDot />}
              <span>{STAGE_LABELS[stage]}</span>
              {isCurrent && isProcessing && elapsed !== null && (
                <span className="font-normal opacity-80">{fmtElapsed(elapsed)}</span>
              )}
              {isAwaitingHere && <span className="font-normal opacity-80">waiting</span>}
            </div>
            {i < PIPELINE_STAGES.length - 1 && (
              <div className={`w-3 h-px ${isDone ? 'bg-status-ok/40' : 'bg-surface-border'}`} />
            )}
          </div>
        );
      })}
    </div>
  );
}

function XMark(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}

function CheckMark(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 8l3.5 3.5L13 5" />
    </svg>
  );
}

function MiniSpinner(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" className="w-3 h-3 animate-spin" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
      <path d="M8 2a6 6 0 1 1-6 6" opacity="0.9" />
    </svg>
  );
}

function EmptyDot(): JSX.Element {
  return <span className="w-1.5 h-1.5 rounded-full bg-ink-muted/40" />;
}

function PauseMark(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" className="w-3 h-3" fill="currentColor">
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

  return (
    <div className="border-r border-surface-border p-4 space-y-3">
      <div>
        <div className="font-mono text-[11px] tracking-[0.2em] uppercase text-ink-muted font-semibold">Title</div>
        <div className="font-semibold">{meeting.title}</div>
      </div>
      <div>
        <div className="font-mono text-[11px] tracking-[0.2em] uppercase text-ink-muted font-semibold">Date</div>
        <div className="text-sm">{meeting.startedAt?.slice(0, 10) ?? '—'}</div>
      </div>
      <div>
        <div className="font-mono text-[11px] tracking-[0.2em] uppercase text-ink-muted font-semibold">Models</div>
        {meeting.models.stt && <div className="text-xs">STT: {meeting.models.stt}</div>}
        {meeting.models.llm && <div className="text-xs">LLM: {meeting.models.llm}</div>}
      </div>
      <div className="pt-3 border-t border-surface-border">
        {neverProcessed ? (
          <button
            onClick={startProcessing}
            className="w-full bg-brand-indigo text-white text-sm font-semibold rounded-lg py-2 hover:bg-brand-indigo/90 transition"
          >
            ▶ Process recording
          </button>
        ) : isProcessing ? (
          <div className="text-xs text-ink-muted italic px-1">
            Processing in progress — re-run options will be available once it
            finishes or fails.
          </div>
        ) : (
          <div className="space-y-1">
            <div className="font-mono text-[11px] tracking-[0.2em] uppercase text-ink-muted font-semibold mb-1">Re-run pipeline from…</div>
            {([
              ['transcribing', 'transcribe + everything after'],
              ['diarizing', 'diarize + everything after'],
              ['summarizing', 'just summary + actions'],
            ] as const).map(([stage, label]) => (
              <button
                key={stage}
                onClick={() => rerunFrom(stage)}
                className="w-full text-left bg-surface-sunken border border-surface-border rounded-lg py-1 px-2 text-xs hover:border-brand-indigo hover:text-brand-indigo"
                title={label}
              >
                ↻ {label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function CenterPane({
  meeting,
  tab,
  onTab,
}: {
  meeting: MeetingDetail;
  tab: Tab;
  onTab: (t: Tab) => void;
}): JSX.Element {
  const showRaw = meeting.transcriptMd === null && meeting.rawTranscriptText !== null;
  return (
    <div>
      {/* Tab labels share the ALL-CAPS tracked treatment used by the
          Library/Inbox section headings, so section-level typography is
          consistent across views. */}
      <div className="flex border-b border-surface-border px-4">
        {(['summary', 'transcript', 'audio'] as const).map((t) => (
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
        {tab === 'summary' && <SummaryPanel meeting={meeting} />}
        {tab === 'transcript' && (
          <>
            {showRaw && (
              <div className="mb-3 text-xs text-status-warnText bg-status-warnBg border border-status-warn/40 rounded-lg px-3 py-2">
                Early preview — raw whisper output. Speaker labels and timestamps
                will be filled in once diarization + merge finish.
              </div>
            )}
            {/* Sans-serif prose for the dialogue text with whitespace-pre-wrap
                to preserve line breaks from transcript.md. The "[Speaker 00:12]"
                prefixes appear inline; treated as part of the prose so names
                like "Alice" read as prose, not code. */}
            <div className="text-sm leading-relaxed whitespace-pre-wrap font-sans">
              {meeting.transcriptMd
                ?? meeting.rawTranscriptText
                ?? 'No transcript yet. Waiting for the transcribe stage to finish.'}
            </div>
          </>
        )}
        {tab === 'audio' && (
          // Wrap the native audio player in a card so it doesn't look
          // like an unstyled OS widget against the rest of the design.
          <div className="bg-surface-sunken border border-surface-border rounded-xl p-4">
            <audio controls src={`file://${meeting.audioPath}`} className="w-full" />
          </div>
        )}
      </div>
    </div>
  );
}

function Placeholder({ text }: { text: string }): JSX.Element {
  return <div className="text-sm text-ink-muted italic">{text}</div>;
}

// ─── Summary panel ─────────────────────────────────────────────────────────
//
// View / Edit / Split modes for the LLM-generated summary. The user owns the
// final text — the summarize stage gives a starting draft, but cleanup is
// almost always needed (model hallucinations, formatting tweaks, redactions).
// Saved markdown is written straight to summary.md on disk; the next pipeline
// run that touches summarize will overwrite, so users wanting to preserve
// edits across re-runs should avoid re-summarizing.
//
// Edits are kept in component state and only persisted on Save. Disk writes
// happen via the meetings:save-summary IPC, NOT via re-running the pipeline.
type SummaryMode = 'preview' | 'edit' | 'split';

function SummaryPanel({ meeting }: { meeting: MeetingDetail }): JSX.Element {
  const original = meeting.summaryMd ?? '';
  const [mode, setMode] = useState<SummaryMode>('preview');
  const [draft, setDraft] = useState(original);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Re-seed the draft when the underlying summary changes (e.g. summarize
  // re-ran, or the user switched meetings without unmounting). We don't want
  // to silently clobber unsaved edits, so we only re-seed when the user is
  // currently in preview mode.
  useEffect(() => {
    if (mode === 'preview') setDraft(original);
  }, [original, mode]);

  const dirty = draft !== original;

  async function save(): Promise<void> {
    if (!dirty || saving) return;
    setSaving(true); setError(null);
    try {
      await api.meetings.saveSummary(meeting.id, draft);
      setSavedAt(new Date());
      // After a successful save, drop back into preview so the rendered
      // markdown reflects what's now on disk.
      setMode('preview');
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
        onMode={setMode}
        dirty={dirty}
        saving={saving}
        savedAt={savedAt}
        error={error}
        onSave={save}
        onRevert={() => { setDraft(original); setError(null); }}
      />
      {mode === 'preview' && <MarkdownPreview source={draft} />}
      {mode === 'edit' && <MarkdownEditor value={draft} onChange={setDraft} />}
      {mode === 'split' && (
        <div className="grid grid-cols-2 gap-4">
          <MarkdownEditor value={draft} onChange={setDraft} />
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
        {(['preview', 'split', 'edit'] as const).map((m) => (
          <button
            key={m}
            onClick={() => onMode(m)}
            className={`px-2.5 py-1 rounded-md transition-colors ${
              mode === m ? 'bg-surface text-ink shadow-sm' : 'text-ink-muted hover:text-ink'
            }`}
          >
            {m === 'preview' ? 'Preview' : m === 'split' ? 'Split' : 'Edit'}
          </button>
        ))}
      </div>
      <div className="flex-1 min-w-0">
        {error && <span className="text-xs text-rose-600 truncate" title={error}>{error}</span>}
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

function MarkdownPreview({ source }: { source: string }): JSX.Element {
  // `prose` gives us reasonable defaults for headings, lists, code blocks,
  // tables (via remark-gfm), and links — without us having to hand-style
  // every element. `whitespace-pre-wrap` is intentionally absent: the
  // markdown renderer handles its own line breaks via paragraph splitting.
  return (
    <div className="prose prose-sm max-w-none prose-headings:mt-3 prose-p:my-2">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{source}</ReactMarkdown>
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

function RightRail({ meeting, onReload }: { meeting: MeetingDetail; onReload: () => Promise<void> }): JSX.Element {
  // Two-step export: clicking a destination opens a modal listing every action
  // item with a checkbox, so the user can opt out of the ones that aren't
  // theirs (LLMs love to turn "somebody should do X" into an action item
  // regardless of who X is). `exporting` holds both the exporter id and a
  // human label so the modal knows where it's sending.
  const [exporting, setExporting] = useState<{ id: string; label: string } | null>(null);
  const hasItems = meeting.actionItems.length > 0;

  return (
    <div className="border-l border-surface-border p-4 space-y-3">
      <SpeakersPanel meeting={meeting} onReload={onReload} />
      <div className="pt-3 border-t border-surface-border space-y-2">
        <div className="font-mono text-[11px] tracking-[0.2em] uppercase text-ink-muted font-semibold flex items-center justify-between">
          <span>Export</span>
          {hasItems && (
            <span className="text-ink-muted/80 font-normal tabular-nums">
              {meeting.actionItems.length} action{meeting.actionItems.length === 1 ? '' : 's'}
            </span>
          )}
        </div>
        <button
          disabled={!hasItems}
          onClick={() => setExporting({ id: 'reminders', label: 'Apple Reminders' })}
          className="w-full bg-brand-indigo text-white text-xs font-semibold rounded-lg py-2 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-brand-indigo/90 transition"
        >
          → Apple Reminders
        </button>
        <button
          disabled={!hasItems}
          onClick={() => setExporting({ id: 'markdown', label: 'Markdown' })}
          className="w-full bg-surface border border-surface-border text-xs font-semibold rounded-lg py-2 disabled:opacity-40 disabled:cursor-not-allowed hover:border-ink/30 transition"
        >
          ↓ Markdown
        </button>
        <button
          disabled
          className="w-full bg-surface-sunken text-ink-muted text-xs font-semibold rounded-lg py-2 cursor-not-allowed"
        >
          → Google Tasks (soon)
        </button>
        {!hasItems && (
          <div className="text-[11px] text-ink-muted italic mt-1">
            No action items yet. Run summarize + extract to get some.
          </div>
        )}
      </div>
      {exporting && (
        <ExportPickerModal
          meeting={meeting}
          exporter={exporting}
          onClose={() => setExporting(null)}
          onReload={onReload}
        />
      )}
    </div>
  );
}

function ExportPickerModal({
  meeting, exporter, onClose, onReload,
}: {
  meeting: MeetingDetail;
  exporter: { id: string; label: string };
  onClose: () => void;
  onReload: () => Promise<void>;
}): JSX.Element {
  // Default: every open item pre-selected. Done items (already checked off in
  // the app) start unchecked because you rarely want to export them again.
  const [selected, setSelected] = useState<Set<string>>(() => {
    return new Set(meeting.actionItems.filter((it) => it.status !== 'done').map((it) => it.id));
  });
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function toggle(id: string): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function selectAll(): void { setSelected(new Set(meeting.actionItems.map((it) => it.id))); }
  function selectNone(): void { setSelected(new Set()); }

  async function run(): Promise<void> {
    if (selected.size === 0) return;
    setBusy(true); setError(null);
    try {
      let outputPath: string | undefined;
      // Markdown is the only file-based exporter right now — ask where to
      // save before running so the user doesn't have to hunt for the file
      // inside the meeting folder afterwards. Apple Reminders writes into
      // the OS, not a file, so no prompt needed.
      if (exporter.id === 'markdown') {
        const safeTitle = meeting.title.replace(/[^\w\s-]+/g, '').trim() || 'action-items';
        const picked = await api.dialog.save({
          defaultPath: `${safeTitle} — Action Items.md`,
          filters: [{ name: 'Markdown', extensions: ['md'] }],
        });
        if (!picked) { setBusy(false); return; } // user cancelled; stay open
        outputPath = picked;
      }
      const message = (await api.export.run(exporter.id, meeting.id, [...selected], outputPath)) as string;
      setResult(message);
      await onReload();
      // Auto-close after a beat so the ✓ message is visible but the user
      // doesn't have to click Close.
      setTimeout(onClose, 1500);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-black/40"
      onClick={onClose}
    >
      <div
        className="bg-surface rounded-2xl shadow-2xl border border-surface-border w-full max-w-xl max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-surface-border flex items-baseline gap-3">
          <h3 className="font-semibold text-sm">Send to {exporter.label}</h3>
          <span className="text-xs text-ink-muted tabular-nums">
            {selected.size}/{meeting.actionItems.length} selected
          </span>
          <div className="flex-1" />
          <button
            onClick={selectAll}
            className="text-[11px] font-semibold text-brand-indigo hover:underline"
          >All</button>
          <button
            onClick={selectNone}
            className="text-[11px] font-semibold text-ink-muted hover:underline"
          >None</button>
        </div>

        <div className="flex-1 overflow-y-auto px-3 py-2 space-y-1">
          {meeting.actionItems.map((it) => {
            const checked = selected.has(it.id);
            return (
              <label
                key={it.id}
                className={`flex items-start gap-3 p-2.5 rounded-lg cursor-pointer transition-colors
                  ${checked ? 'bg-brand-indigo/5' : 'hover:bg-surface-sunken'}
                  ${it.status === 'done' ? 'opacity-60' : ''}`}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggle(it.id)}
                  className="mt-1 w-4 h-4 accent-brand-indigo shrink-0"
                />
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-ink">{it.text}</div>
                  <div className="text-[11px] text-ink-muted mt-0.5 flex items-center gap-2">
                    {it.ownerName && <span>👤 {it.ownerName}</span>}
                    {it.dueDate && <span>📅 {it.dueDate}</span>}
                    {it.status === 'done' && (
                      <span className="bg-status-okBg text-status-ok font-semibold px-1.5 rounded">DONE</span>
                    )}
                    {it.exportedTo.includes(exporter.id) && (
                      <span className="bg-surface-sunken text-ink-muted font-semibold px-1.5 rounded">
                        already sent
                      </span>
                    )}
                  </div>
                </div>
              </label>
            );
          })}
        </div>

        <div className="px-5 py-3 border-t border-surface-border flex items-center gap-3">
          {error && <div className="text-xs text-rose-600 flex-1 truncate" title={error}>{error}</div>}
          {result && <div className="text-xs text-status-ok flex-1 truncate" title={result}>✓ {result}</div>}
          {!error && !result && <div className="flex-1" />}
          <button
            onClick={onClose}
            className="text-sm text-ink-muted hover:text-ink px-3 py-1.5 rounded-lg hover:bg-surface-sunken transition"
          >
            {result ? 'Close' : 'Cancel'}
          </button>
          {!result && (
            <button
              disabled={busy || selected.size === 0}
              onClick={run}
              className="text-sm font-semibold bg-brand-indigo text-white px-4 py-1.5 rounded-lg hover:bg-brand-indigo/90 disabled:opacity-40 disabled:cursor-not-allowed transition"
            >
              {busy ? 'Sending…' : `Send ${selected.size}`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Speakers panel ────────────────────────────────────────────────────────
//
// The roster lives cross-meeting; the per-meeting concern here is "who is
// this SPEAKER_03 voice?" We let the user click a speaker, play a short clip
// of that voice, then either pick a known name from the roster dropdown or
// type a new one. On a successful assign, the averaged embedding gets merged
// into the roster entry so future meetings auto-match that voice.

interface RosterEntry { id: string; displayName: string; }

function SpeakersPanel({
  meeting, onReload,
}: {
  meeting: MeetingDetail;
  onReload: () => Promise<void>;
}): JSX.Element {
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  // Bump on every assign/unlink so the roster dropdown re-fetches (newly-
  // created entries appear immediately).
  const [version, setVersion] = useState(0);

  useEffect(() => {
    void (async () => {
      const list = (await api.speakers.list()) as { id: string; displayName: string }[];
      setRoster(list);
    })();
  }, [version]);

  async function reloadMeeting(): Promise<void> {
    // Re-fetch roster (new entries may have been created) AND the meeting
    // detail (so the assigned name shows up immediately without waiting on
    // the parent's polling, which may have stopped after 'done').
    setVersion((v) => v + 1);
    await onReload();
  }

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between">
        <div className="font-mono text-[11px] tracking-[0.2em] uppercase text-ink-muted font-semibold">Speakers</div>
        {meeting.speakers.length > 0 && (
          <div className="text-[10px] text-ink-muted tabular-nums">
            {meeting.speakers.filter((sp) => sp.rosterId).length}/{meeting.speakers.length} named
          </div>
        )}
      </div>

      {meeting.speakers.length === 0 && (
        <div className="text-xs text-ink-muted italic">
          No speakers yet. Available after diarize + identify.
        </div>
      )}

      <div className="space-y-1.5">
        {meeting.speakers.map((sp, i) => (
          <SpeakerRow
            key={sp.localLabel}
            meetingId={meeting.id}
            localLabel={sp.localLabel}
            displayName={sp.displayName}
            rosterId={sp.rosterId}
            colorIdx={i}
            roster={roster}
            isOpen={expanded === sp.localLabel}
            onToggle={() => setExpanded((prev) => (prev === sp.localLabel ? null : sp.localLabel))}
            onChanged={reloadMeeting}
          />
        ))}
      </div>
    </div>
  );
}

function SpeakerRow({
  meetingId, localLabel, displayName, rosterId, colorIdx, roster,
  isOpen, onToggle, onChanged,
}: {
  meetingId: string;
  localLabel: string;
  displayName: string | null;
  rosterId: string | null;
  colorIdx: number;
  roster: RosterEntry[];
  isOpen: boolean;
  onToggle: () => void;
  onChanged: () => void;
}): JSX.Element {
  const named = rosterId !== null;
  const color = colorForSpeakerIndex(colorIdx);

  return (
    <div
      className={`
        rounded-lg text-xs transition-colors
        ${named ? 'bg-surface-sunken' : 'bg-status-warnBg border border-dashed border-status-warn'}
        ${isOpen ? 'ring-2 ring-brand-indigo/40' : ''}
      `}
    >
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-2 p-2 text-left"
        aria-expanded={isOpen}
      >
        <div
          className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold text-white shrink-0"
          style={{ background: color }}
        >
          {(displayName?.[0] ?? localLabel.replace('SPEAKER_', '').slice(-1) ?? '?').toUpperCase()}
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-semibold truncate">{displayName ?? localLabel}</div>
          {named && <div className="text-[10px] text-ink-muted font-mono">{localLabel}</div>}
        </div>
        <svg
          viewBox="0 0 16 16"
          className={`w-3 h-3 text-ink-muted shrink-0 transition-transform ${isOpen ? 'rotate-180' : ''}`}
          fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
        >
          <path d="M3 6l5 5 5-5" />
        </svg>
      </button>
      {isOpen && (
        <SpeakerEditor
          meetingId={meetingId}
          localLabel={localLabel}
          rosterId={rosterId}
          roster={roster}
          onChanged={onChanged}
        />
      )}
    </div>
  );
}

function SpeakerEditor({
  meetingId, localLabel, rosterId, roster, onChanged,
}: {
  meetingId: string;
  localLabel: string;
  rosterId: string | null;
  roster: RosterEntry[];
  onChanged: () => void;
}): JSX.Element {
  const [sample, setSample] = useState<{ dataUri: string; startS: number; endS: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Lazy-load the sample the first time the row expands; keeps Library scroll
  // snappy when the user is just browsing through 10 speakers without playing.
  useEffect(() => {
    let alive = true;
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const s = await api.speakers.sample(meetingId, localLabel);
        if (!alive) return;
        setSample(s ?? null);
        if (!s) setError('No clip available — speaker has no segments long enough.');
      } catch (e) {
        if (!alive) return;
        setError((e as Error).message);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [meetingId, localLabel]);

  async function assignExisting(rid: string): Promise<void> {
    setBusy(true); setError(null);
    try {
      await api.speakers.assign({ meetingId, localLabel, mode: 'existing', rosterId: rid });
      onChanged();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  async function createNew(): Promise<void> {
    const name = newName.trim();
    if (!name) return;
    setBusy(true); setError(null);
    try {
      await api.speakers.assign({ meetingId, localLabel, mode: 'new', displayName: name });
      setNewName('');
      onChanged();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  async function unlink(): Promise<void> {
    setBusy(true); setError(null);
    try {
      await api.speakers.unlink(meetingId, localLabel);
      onChanged();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  // Narrow the roster dropdown options to not include the currently-linked
  // entry (it'd be a no-op) so the user always sees actionable choices.
  const assignableRoster = roster.filter((r) => r.id !== rosterId);

  return (
    <div className="border-t border-surface-border px-2 py-2 space-y-2">
      {/* Audio player */}
      {loading && (
        <div className="text-[11px] text-ink-muted italic flex items-center gap-1.5">
          <MiniSpinner /> Loading sample…
        </div>
      )}
      {sample && (
        <div className="flex items-center gap-2">
          <button
            onClick={() => audioRef.current?.play()}
            className="shrink-0 w-7 h-7 rounded-full bg-brand-indigo text-white flex items-center justify-center hover:bg-brand-indigo/90 transition"
            aria-label="Play sample"
          >
            <svg viewBox="0 0 16 16" className="w-3 h-3" fill="currentColor">
              <path d="M4 3v10l9-5z" />
            </svg>
          </button>
          <audio ref={audioRef} src={sample.dataUri} preload="auto" controls className="flex-1 h-7" />
        </div>
      )}
      {sample && (
        <div className="text-[10px] text-ink-muted tabular-nums">
          Clip from {fmtSec(sample.startS)} – {fmtSec(sample.endS)} ({(sample.endS - sample.startS).toFixed(1)}s)
        </div>
      )}

      {/* Assign to existing roster entry */}
      {assignableRoster.length > 0 && (
        <div>
          <div className="text-[10px] font-bold text-ink-muted uppercase mb-1">Assign to</div>
          <select
            disabled={busy}
            value=""
            onChange={(e) => {
              if (e.target.value) void assignExisting(e.target.value);
              e.target.value = '';
            }}
            className="w-full text-xs border border-surface-border rounded-md bg-surface px-2 py-1
                       focus:outline-none focus:border-brand-indigo"
          >
            <option value="">— pick a known speaker —</option>
            {assignableRoster.map((r) => (
              <option key={r.id} value={r.id}>{r.displayName}</option>
            ))}
          </select>
        </div>
      )}

      {/* Create a new roster entry */}
      <div>
        <div className="text-[10px] font-bold text-ink-muted uppercase mb-1">Or add new</div>
        <div className="flex gap-1.5">
          <input
            disabled={busy}
            value={newName}
            placeholder="Full name"
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void createNew(); }}
            className="flex-1 text-xs border border-surface-border rounded-md bg-surface px-2 py-1
                       focus:outline-none focus:border-brand-indigo placeholder:text-ink-muted"
          />
          <button
            disabled={busy || newName.trim().length === 0}
            onClick={createNew}
            className="text-xs font-semibold px-2.5 py-1 rounded-md bg-brand-indigo text-white
                       disabled:opacity-40 disabled:cursor-not-allowed hover:bg-brand-indigo/90 transition"
          >
            Save
          </button>
        </div>
      </div>

      {rosterId !== null && (
        <button
          disabled={busy}
          onClick={unlink}
          className="text-[11px] text-ink-muted hover:text-rose-600 transition underline decoration-dotted"
        >
          Unassign
        </button>
      )}

      {error && <div className="text-[11px] text-rose-600">{error}</div>}
    </div>
  );
}

function fmtSec(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60).toString().padStart(2, '0');
  return `${m}:${sec}`;
}
