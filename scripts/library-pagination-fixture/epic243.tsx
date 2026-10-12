import React, { Profiler, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../electron/renderer/src/index.css';
import { ToastHost } from '../../electron/renderer/src/components/Toasts';
import type { WeeklyActionItem, WeeklySnapshot, WeeklyNarrative } from '../../electron/main/ipc/contracts';
import { getIsoWeek, addWeeks, isoWeekRange } from '../../electron/shared/local-week';
import type { MeetingDetail } from '../../electron/renderer/src/views/MeetingDetailView';
const baseline = new URLSearchParams(location.search).has('baseline');
const baselineModulePath = '../../electron/renderer/src/views/.epic243-baseline-transcript.tsx';
const text = Array.from({ length: 12000 }, (_, index) => {
  const seconds = index * 2,
    h = Math.floor(seconds / 3600),
    m = Math.floor((seconds % 3600) / 60),
    s = seconds % 60;
  return `[Speaker ${Math.floor(index / 3) % 4} ${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}] ${index === 11000 ? 'NEEDLE-UNMOUNTED ' : ''}${'Synthetic meeting discussion with a variable-length sentence. '.repeat((index % 6) + 1)}`;
}).join('\n');
const fixture = {
  commits: [] as number[],
  opened: 0,
  toggled: 0,
  selected: false,
  modalClosed: 0,
  setTime: null as null | ((time: number) => void),
  setMode: null as null | ((mode: string) => void),
  rerender: null as null | (() => void),
  taskCalls: [] as { kind: string; patch: unknown }[],
  failNextTask: true,
  saved: 0,
  finishBackup:null as null|(()=>void),
  finishWeekly: null as null | ((fail: boolean) => void),
  weeklyGenerations: 0,
  weeklyExports: [] as string[],
  emptyLegacyReport: null as null | (() => void),
};
(window as unknown as { fixture: typeof fixture }).fixture = fixture;
window.api = {
  onMenuAction: () => () => {},
  speakers: { list: async () => [] },
  meetings: { exportTranscript: async () => ({ cancelled: true }) },
  actionItems: {
    setStatus: async (_id: string, status: string) => {
      fixture.taskCalls.push({ kind: 'status', patch: status });
      if (fixture.failNextTask) {
        fixture.failNextTask = false;
        throw Error('Synthetic save failed');
      }
    },
    update: async (_id: string, patch: unknown) => {
      fixture.taskCalls.push({ kind: 'update', patch });
    },
  },
} as unknown as typeof window.api;
window.api.backup={preview:async()=>({destination:'/synthetic/private-backup',bytes:1024,files:4,missing:[]}),status:async()=>({state:'working',completed:2,total:4,destination:'/synthetic/private-backup'}),run:async()=>{await new Promise<void>(resolve=>{fixture.finishBackup=resolve;});return{state:'complete',completed:4,total:4,destination:'/synthetic/private-backup'};}};
const reportWeek = addWeeks(getIsoWeek(), -1);
const reportRange = isoWeekRange(reportWeek.year, reportWeek.week);
const savedSnapshot: WeeklySnapshot = {
  isoYear: reportWeek.year, isoWeek: reportWeek.week,
  rangeStart: reportRange.start.toISOString(), rangeEnd: reportRange.end.toISOString(),
  totalDurationS: 60, inProgress: false,
  meetings: [{ id: 'saved-meeting', title: 'Saved source meeting', startedAt: reportRange.start.toISOString(), durationS: 60, speakerCount: 2, highlight: 'Original recap' }],
  openActionCount: 1,
  openActionGroups: [{ ownerLabel: 'Original owner', isYou: false, items: [{
    id: 'saved-task', meetingId: 'saved-meeting', meetingTitle: 'Saved source meeting',
    text: 'Historical action', status: 'open', ownerLabel: 'Original owner', isYou: false,
    dueDate: null, meetingStartedAt: reportRange.start.toISOString(),
  }] }],
};
let weeklyReport: WeeklyNarrative = {
  narrative: 'Permanent saved overview', themes: [{ title: 'Original theme', detail: 'Saved detail', meetings: ['Saved source meeting'] }],
  decisions: ['Original decision'], generatedAt: reportRange.end.toISOString(), fromCache: true, snapshot: savedSnapshot,
};
fixture.emptyLegacyReport = () => {
  weeklyReport = { ...weeklyReport, narrative: 'Legacy overview without source meetings',
    snapshot: { ...savedSnapshot, meetings: [], totalDurationS: 0, openActionGroups: [],
      openActionCount: 0, legacySnapshot: true, capturedAt: new Date().toISOString() } };
};
window.api.weekly = {
  getStructured: async (year, week) => {
    if (year === reportWeek.year && week === reportWeek.week) {
      return { ...structuredClone(weeklyReport.snapshot!), savedAt: weeklyReport.generatedAt, hasFreshCache: true };
    }
    const range = isoWeekRange(year, week);
    return { ...structuredClone(savedSnapshot), isoYear: year, isoWeek: week,
      rangeStart: range.start.toISOString(), rangeEnd: range.end.toISOString(), inProgress: true, hasFreshCache: false };
  },
  getNarrative: async (_year, _week, force) => {
    if (force) {
      fixture.weeklyGenerations++;
      await new Promise<void>((resolve, reject) => { fixture.finishWeekly = fail => fail ? reject(Error('Synthetic model offline')) : resolve(); });
      weeklyReport = { narrative: 'Replacement saved overview', themes: [], decisions: ['Replacement decision'],
        generatedAt: new Date().toISOString(), fromCache: false,
        snapshot: { ...savedSnapshot, meetings: [{ ...savedSnapshot.meetings[0]!, title: 'Replacement source meeting' }], openActionGroups: [], openActionCount: 0 } };
    }
    return structuredClone(weeklyReport);
  },
  get: async () => { throw Error('Unused'); },
  regenerate: async () => { throw Error('Unused'); },
  exportMarkdown: async () => {
    fixture.weeklyExports.push(weeklyReport.snapshot!.meetings[0]!.title);
    return { markdown: weeklyReport.narrative, path: '/synthetic/weekly.md' };
  },
};
const {TranscriptPanel}=await import('../../electron/renderer/src/views/MeetingTranscriptPanel');
const {ModalShell}=await import('../../electron/renderer/src/components/ModalShell');
const {ConfirmDialog}=await import('../../electron/renderer/src/components/ConfirmDialog');
const {LibraryRow}=await import('../../electron/renderer/src/components/LibraryRow');
const {WeeklyTaskRow}=await import('../../electron/renderer/src/components/WeeklyTaskRow');
const {WeeklyView}=await import('../../electron/renderer/src/views/WeeklyView');
const {LibraryBackupPanel}=await import('../../electron/renderer/src/components/LibraryBackupPanel');
const Baseline=baseline?((await import(/* @vite-ignore */ baselineModulePath)) as {TranscriptPanel:typeof TranscriptPanel}).TranscriptPanel:TranscriptPanel;
function Fixture(): JSX.Element {
  const [task, setTask] = useState<WeeklyActionItem>({
    id: 'task',
    meetingId: 'fixture',
    meetingTitle: 'Source meeting',
    text: 'Follow up',
    ownerLabel: 'Dan',
    isYou: true,
    meetingStartedAt: '2026-10-05T12:00:00Z',
    ownerName: 'Dan',
    dueDate: '2026-10-09',
    status: 'open',
    sourceQuote: 'Original task source',
  });
  const [time, setTime] = useState(-1),
    [mode, setMode] = useState('transcript'),
    [modal, setModal] = useState(false),
    [nested, setNested] = useState(false),
    [busy, setBusy] = useState(false),
    [tick, setTick] = useState(0),
    [selected, setSelected] = useState(false);
  fixture.setTime = setTime;
  fixture.setMode = setMode;
  fixture.rerender = () => setTick((value) => value + 1);
  const meeting = {
    id: 'fixture',
    title: 'Synthetic six-hour meeting',
    startedAt: '2026-10-05T12:00:00Z',
    transcriptMd: text,
  } as unknown as MeetingDetail;
  return (
    <main className="flex flex-col p-4" style={{ height: '100vh' }}>
      <div className="shrink-0 flex gap-3">
        <button id="open-modal" onClick={() => setModal(true)}>
          Open dialog
        </button>
        <button id="mode" onClick={() => setMode(mode === 'transcript' ? 'row' : 'transcript')}>
          Switch fixture
        </button>
        <button onClick={() => setTick(tick + 1)}>Rerender {tick}</button>
      </div>
      {mode === 'transcript' ? (
        <div id="scroll" className="flex-1 min-h-0 overflow-y-auto">
          <Profiler
            id="transcript"
            onRender={(_id, _phase, duration) => fixture.commits.push(duration)}
          >
            <Baseline meeting={meeting} showRaw={false} currentTime={time} onSeek={setTime} />
          </Profiler>
        </div>
      ) : mode === 'weekly' ? <WeeklyView onNav={() => {}} onOpenMeeting={() => fixture.opened++}/>
      : mode==='backup'?<LibraryBackupPanel/>:mode === 'tasks' ? (
        <WeeklyTaskRow
          item={task}
          rangeEnd="2026-10-11"
          onOpen={() => fixture.opened++}
          onPatch={(_id, patch) => setTask((current) => ({ ...current, ...patch }))}
          onSaved={async () => {
            fixture.saved++;
          }}
        />
      ) : (
        <LibraryRow
          meeting={{
            id: 'row',
            title: 'Keyboard meeting',
            groupId: null,
            startedAt: null,
            durationS: 60,
            pipelineStage: 'done',
            status: 'done',
            stageStartedAt: null,
            unidentifiedCount: 0,
            actionItemsCount: 0,
            speakers: [],
          }}
          onOpen={() => {
            fixture.opened++;
          }}
          onChanged={() => {}}
          checked={selected}
          onToggle={() => {
            fixture.toggled++;
            setSelected(!selected);
            fixture.selected = !selected;
          }}
          selectionActive={selected}
        />
      )}
      {modal && (
        <ModalShell
          title="Outer dialog"
          busy={busy}
          onClose={() => {
            fixture.modalClosed++;
            setModal(false);
          }}
        >
          <input id="dialog-edit" aria-label="Edit value" defaultValue="Keep editing" />
          <button onClick={() => setTick(tick + 1)}>Rerender dialog</button>
          <button id="make-busy" onClick={() => setBusy(!busy)}>
            Toggle busy
          </button>
          <button id="nested" onClick={() => setNested(true)}>
            Nested dialog
          </button>
          <button id="close-modal" disabled={busy} onClick={() => setModal(false)}>
            Close
          </button>
          <ConfirmDialog
            open={nested}
            title="Nested dialog"
            body="Nested confirmation"
            onCancel={() => setNested(false)}
            onConfirm={() => setNested(false)}
          />
        </ModalShell>
      )}
    </main>
  );
}
createRoot(document.getElementById('root')!).render(
  <ToastHost>
    <Fixture />
  </ToastHost>,
);
