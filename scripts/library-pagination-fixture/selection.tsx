import React from 'react';
import { createRoot } from 'react-dom/client';
import type { MeetingSummary, MeetingFilter } from '../../electron/renderer/src/lib/paged-meetings';
import '../../electron/renderer/src/index.css';

// The only bridge in this renderer is this in-memory fake. There is no preload.
const startup = new URLSearchParams(location.search).has('startup');
const processing = new URLSearchParams(location.search).has('processing');
const groupA = '00000000-0000-4000-8000-000000000001';
const groupB = '00000000-0000-4000-8000-000000000002';
const geometry = { reads: 0 };
if (startup && new URLSearchParams(location.search).has('jitter')) {
  const original = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function () {
    const rect = original.call(this);
    if (this instanceof HTMLDivElement && this.classList.contains('relative') && this.style.height) {
      // Subpixel layout noise must not recursively update React in a layout effect.
      const offset = ++geometry.reads % 2 ? 0.125 : -0.125;
      return new DOMRect(rect.x, rect.y + offset, rect.width, rect.height);
    }
    return rect;
  };
}
const data: MeetingSummary[] = Array.from({ length: startup ? 600 : 120 }, (_, index) => ({
  id: `selection-${index}`, slug: `selection-${index}`, title: `Synthetic meeting ${index}`,
  startedAt: '2026-09-08T12:00:00Z', durationS: 1800,
  status: index < 12 ? 'pending' : 'done', pipelineStage: index < 12 ? 'discovered' : 'done',
  errorMessage: null, stageStartedAt: null, skipSpeakerId: false, unidentifiedCount: 0,
  actionItemsCount: 0, stageEtaMs: null, stageEtaRough: false, speakers: [],
  groupId: !startup || index < 200 ? null : index < 400 ? groupA : groupB,
  groupName: !startup || index < 200 ? null : index < 400 ? 'Planning' : 'Reviews',
}));
const deleted = new Set<string>();
const calls = { pages: [] as unknown[], ids: [] as string[], process: [] as string[][], delete: [] as string[], undo: [] as string[], opened: [] as string[] };
let queue = { paused: false, currentId: null as string | null, queueLength: 0, queueIds: [] as string[] };
const pipelineListeners = new Set<(status: typeof queue) => void>();
let finishQueue: (() => void) | null = null;
let holdQueue = false;
let rejectQueue = false;
const live = () => data.filter((row) => !deleted.has(row.id));
const matching = (filter: MeetingFilter) => live().filter((row) => filter === 'all' || (filter === 'processing' ? ['processing', 'awaiting_user'].includes(row.status) : row.status === filter));
const counts = () => ({ all: live().length, pending: matching('pending').length, processing: matching('processing').length, done: matching('done').length, failed: matching('failed').length });
const subscribers = new Set<() => void>();
const off = () => () => {};
window.api = {
  groups: { list: async () => ({groups: startup ? [
    {id: groupA, name: 'Planning', count: 200}, {id: groupB, name: 'Reviews', count: 200},
  ] : [], allCount: live().length, ungroupedCount: startup ? 200 : live().length}) },
  meetings: {
    listPage: async (query: { filter: MeetingFilter; cursor?: string; pageSize?: number; groupId?: string | null }) => {
      calls.pages.push(query);
      const rows = matching(query.filter).filter(row => query.groupId === undefined || row.groupId === query.groupId);
      const start = Number(query.cursor ?? 0), end = Math.min(rows.length, start + (query.pageSize ?? 50));
      return { items: structuredClone(rows.slice(start, end)), total: rows.length, counts: counts(), nextCursor: end < rows.length ? String(end) : null };
    },
    listIds: async (filter: MeetingFilter) => { calls.ids.push(filter); return matching(filter).map((row) => row.id); },
    getMany: async (ids: string[]) => structuredClone(ids.flatMap((id) => live().filter((row) => row.id === id))),
    onAdded: (listener: () => void) => { subscribers.add(listener); return () => subscribers.delete(listener); },
    startManyDetailed: async (ids: string[]) => {
      calls.process.push([...ids]);
      if (holdQueue) await new Promise<void>(resolve => { finishQueue = resolve; });
      if (rejectQueue) throw new Error('Synthetic queue unavailable');
      const failedIds = ids.filter((id) => id === 'selection-0');
      const startedIds = ids.filter((id) => id !== 'selection-0');
      for (const row of data) if (startedIds.includes(row.id)) { row.status = 'processing'; row.pipelineStage = 'transcribing'; }
      if (processing) {
        queue = { ...queue, currentId: startedIds[0] ?? null, queueLength: Math.max(0, startedIds.length - 1), queueIds: startedIds.slice(1) };
        pipelineListeners.forEach(listener => listener(queue));
      }
      return { startedIds, failedIds };
    },
    start: async (id: string) => {
      data.find(row => row.id === id)!.status = 'processing';
      queue = { ...queue, currentId: id };
      pipelineListeners.forEach(listener => listener(queue));
    },
    delete: async (id: string) => {
      calls.delete.push(id);
      if (id === 'selection-0') throw new Error('Synthetic delete rejection');
      if (id === 'selection-11' || deleted.has(id)) return false;
      deleted.add(id); return true;
    },
    undoDelete: async (id: string) => { calls.undo.push(id); return deleted.delete(id); },
  },
  search: { query: async () => [], cancel: async () => {}, run: async () => ({ status: 'complete', hits: [110, 111].map((index) => ({ meetingId: `selection-${index}`, title: `Synthetic meeting ${index}`, source: 'title', line: 0, text: `Synthetic meeting ${index}` })) }) },
  pipeline: { status: async () => queue, onStatusChange: (listener: (status: typeof queue) => void) => { pipelineListeners.add(listener); return () => pipelineListeners.delete(listener); },
    pause: async () => { queue = { ...queue, paused: true }; pipelineListeners.forEach(listener => listener(queue)); },
    resume: async () => { queue = { ...queue, paused: false }; pipelineListeners.forEach(listener => listener(queue)); },
  },
  recording: { onStateChange: off, onLevel: off }, meetingDetector: { onDetected: off },
  recovery: { list: async () => startup ? Array.from({length: 113}, (_, index) => ({
    id: `recovery-${index}`, targetLabel: 'Synthetic call', startedAt: '2026-01-01T00:00:00Z',
    outputPath: `/tmp/synthetic-${index}.m4a`, status: 'orphaned', reason: 'unreadable',
    durationS: null, sizeBytes: 1024, canRecover: false, canTrim: false,
  })) : [] }, trash: { list: async () => [] },
} as any;

const { librarySelection } = await import('../../electron/renderer/src/lib/selection');
// This fixture verifies flat-list selection snapshots. Grouped rendering has
// its own fixture; fresh profiles now default to Organized in the real app.
window.localStorage.setItem('libraryViewMode', startup ? 'organized' : 'flat');
if (startup) window.localStorage.setItem('libraryExpandedGroups', JSON.stringify(['ungrouped', groupA, groupB]));
const { useMeetingsStore } = await import('../../electron/renderer/src/store/meetings');
const { LibraryView } = await import('../../electron/renderer/src/views/LibraryView');
const { ToastHost } = await import('../../electron/renderer/src/components/Toasts');
(window as any).fixture = {
  selection: librarySelection, store: useMeetingsStore, calls, geometry,
  holdQueue() { holdQueue = true; },
  finishQueue() { holdQueue = false; finishQueue?.(); },
  rejectQueue() { rejectQueue = true; },
  pushStage() {
    data.filter(row => row.status === 'processing').forEach(row => { row.pipelineStage = 'diarizing'; });
    pipelineListeners.forEach(listener => listener({ ...queue }));
  },
  arrive() {
    data.unshift({ ...data[119]!, id: 'later-arrival', slug: 'later-arrival', title: 'Later synthetic arrival' });
    subscribers.forEach((listener) => listener());
  },
  statusChanged() { data.find((row) => row.id === 'selection-11')!.status = 'done'; },
};
createRoot(document.getElementById('root')!).render(<ToastHost><div style={{ height: '100vh' }}><LibraryView
  onOpen={id => { calls.opened.push(id); }} onNav={() => {}} onOpenSearch={() => {}}
  liveRecording={new URLSearchParams(location.search).has('live') ? {sessionId: 'synthetic-live',label: 'Synthetic live capture',startedAt: new Date().toISOString()} : null}
  onStartRecording={() => { throw new Error('Recording is forbidden in this synthetic fixture'); }} onRecordingStopped={() => {}}
/></div></ToastHost>);
