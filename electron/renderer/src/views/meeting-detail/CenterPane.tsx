// electron/renderer/src/views/meeting-detail/CenterPane.tsx
// Tabbed centre pane of the meeting page, moved out of MeetingDetailView.tsx (#256).
import { ErrorBoundary } from '../../components/ErrorBoundary';
import { TerminologyPanel } from '../../components/Terminology';
import { SlidingPill } from '../../components/motion/SlidingPill';
import { nextTabIndex } from '../../lib/tab-keys';
import { usePlaybackTime, type PlaybackClock } from '../../lib/playback-clock';
import type { DetailArtifactState } from '../../lib/detail-artifacts';
import { ActionItemsPanel } from '../MeetingActionsPanel';
import { TranscriptPanel } from '../MeetingTranscriptPanel';
import { ArtifactFeedback } from './ArtifactFeedback';
import { SummaryPanel } from './SummaryPanel';
import { useContentVersion } from './hooks/useContentVersion';
import type { MeetingDetail, SummaryMode, Tab } from './types';

const DETAIL_TABS = ['summary', 'transcript', 'actions'] as const;
// The first tab holds what every other surface (banners, history, menus,
// the Library) calls "Notes"; it used to be the one place saying "Summary".
const TAB_LABELS: Record<typeof DETAIL_TABS[number], string> = { summary: 'Notes', transcript: 'Transcript', actions: 'Actions' };

export function CenterPane({
  meeting, tab, onTab, playbackClock, seekRevision, onSeek, onReload, onShowSource, provenance,
  summaryMode, onSummaryMode, summaryDraft, onSummaryDraft, summarySaved, onSummaryBaseline,
  transcriptState, onRetryTranscript,
}: {
  meeting: MeetingDetail;
  tab: Tab;
  onTab: (t: Tab) => void;
  playbackClock: PlaybackClock;
  seekRevision: number;
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
  const contentVersion = useContentVersion(meeting.transcriptMd, meeting.summaryMd);
  const openActionCount = meeting.actionItems.filter((item) => item.status !== 'done').length;
  return (
    <div>
      {/* Sentence-case tabs share the app's system typography.
          Audio is a sticky footer, not a
          tab — keeps playback alive while reading either tab.
          Sticky-pinned to the top of the center-pane scroll container
          so SUMMARY/TRANSCRIPT/ACTIONS stay reachable while paging
          through a long summary or transcript. */}
      <div role="tablist" aria-label="Meeting sections" className="detail-tabs sticky top-0 z-10 bg-surface flex border-b border-surface-border px-4">
        {DETAIL_TABS.map((t, index) => (
          <button
            key={t}
            type="button"
            role="tab"
            id={`detail-tab-${t}`}
            aria-selected={tab === t}
            aria-controls="detail-tabpanel"
            tabIndex={tab === t ? 0 : -1}
            onClick={() => onTab(t)}
            onKeyDown={(event) => {
              const next = nextTabIndex(event.key, index, DETAIL_TABS.length);
              if (next === null) return;
              // Left/Right also drive the audio transport; inside the tab
              // list they move between tabs instead.
              event.preventDefault();
              event.stopPropagation();
              event.nativeEvent.stopImmediatePropagation();
              onTab(DETAIL_TABS[next]!);
              document.getElementById(`detail-tab-${DETAIL_TABS[next]!}`)?.focus();
            }}
            className={`relative px-3 py-3 text-[13px] capitalize transition
              ${tab === t ? 'text-brand-indigo font-semibold' : 'text-ink-muted hover:text-ink'}`}
          >
            {TAB_LABELS[t]}{t === 'actions' && meeting.actionItems.length > 0 && (
              <span className="ml-1.5 rounded-full bg-surface-sunken px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-ink-muted"
                aria-label={`${openActionCount} open of ${meeting.actionItems.length}`}>
                {openActionCount}/{meeting.actionItems.length}
              </span>
            )}
            {tab === t && <SlidingPill group="detail-tabs" className="-bottom-px h-0.5 bg-brand-indigo" />}
          </button>
        ))}
      </div>
      <div id="detail-tabpanel" role="tabpanel" aria-labelledby={`detail-tab-${tab}`} className="p-5">
        {tab === 'summary' && (
          <ErrorBoundary scope="detail:notes" label="Notes" variant="panel" resetKey={meeting.id}>
          <SummaryPanel
            key={meeting.id}
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
          </ErrorBoundary>
        )}
        {tab === 'transcript' && (
          <ErrorBoundary scope="detail:transcript" label="The transcript" variant="panel" resetKey={meeting.id}>
            <ArtifactFeedback label="transcript" state={transcriptState} onRetry={onRetryTranscript} />
            {meeting.transcriptMd && <TerminologyPanel key={`terms-${meeting.id}`} meetingId={meeting.id} artifact="meeting" version={contentVersion}
              groupId={meeting.groupId} groupName={meeting.groupName} disabled={meeting.status === 'processing' || summaryDraft !== summarySaved || summaryMode === 'edit'} onReload={onReload}/>}
            {transcriptState.data !== undefined && <PlaybackTranscriptPanel
              seekRevision={seekRevision}
              meeting={meeting}
              showRaw={showRaw}
              clock={playbackClock}
              onSeek={onSeek}
            />}
          </ErrorBoundary>
        )}
        {tab === 'actions' && <ErrorBoundary scope="detail:actions" label="Action items" variant="panel" resetKey={meeting.id}><ActionItemsPanel meeting={meeting} onReload={onReload} onShowSource={onShowSource} /></ErrorBoundary>}
      </div>
    </div>
  );
}

/** The one subscriber to the playback clock: a tick re-renders this wrapper
 *  and the transcript, nothing above them. */
function PlaybackTranscriptPanel({ clock, ...rest }: Omit<Parameters<typeof TranscriptPanel>[0], 'currentTime'> & { clock: PlaybackClock }): JSX.Element {
  return <TranscriptPanel {...rest} currentTime={usePlaybackTime(clock)} />;
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

