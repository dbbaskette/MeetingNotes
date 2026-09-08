import React from 'react';
import { createRoot } from 'react-dom/client';
import type { MeetingSummary, MeetingFilter } from '../../electron/renderer/src/lib/paged-meetings';
import '../../electron/renderer/src/index.css';

// The only bridge in this renderer is this in-memory fake. There is no preload.
const data: MeetingSummary[] = Array.from({ length: 120 }, (_, index) => ({
  id: `selection-${index}`, slug: `selection-${index}`, title: `Synthetic meeting ${index}`,
  startedAt: '2026-09-08T12:00:00Z', durationS: 1800,
  status: index < 12 ? 'pending' : 'done', pipelineStage: index < 12 ? 'discovered' : 'done',
  errorMessage: null, stageStartedAt: null, skipSpeakerId: false, unidentifiedCount: 0,
  actionItemsCount: 0, stageEtaMs: null, stageEtaRough: false, speakers: [],
}));
const deleted = new Set<string>();
const calls = { pages: [] as unknown[], ids: [] as string[], process: [] as string[][], delete: [] as string[], undo: [] as string[] };
const live = () => data.filter((row) => !deleted.has(row.id));
const matching = (filter: MeetingFilter) => live().filter((row) => filter === 'all' || (filter === 'processing' ? ['processing', 'awaiting_user'].includes(row.status) : row.status === filter));
const counts = () => ({ all: live().length, pending: matching('pending').length, processing: matching('processing').length, done: matching('done').length, failed: matching('failed').length });
const subscribers = new Set<() => void>();
const off = () => () => {};
window.api = {
  meetings: {
    listPage: async (query: { filter: MeetingFilter; cursor?: string; pageSize?: number }) => {
      calls.pages.push(query);
      const rows = matching(query.filter);
      const start = Number(query.cursor ?? 0), end = Math.min(rows.length, start + (query.pageSize ?? 50));
      return { items: structuredClone(rows.slice(start, end)), total: rows.length, counts: counts(), nextCursor: end < rows.length ? String(end) : null };
    },
    listIds: async (filter: MeetingFilter) => { calls.ids.push(filter); return matching(filter).map((row) => row.id); },
    getMany: async (ids: string[]) => structuredClone(ids.flatMap((id) => live().filter((row) => row.id === id))),
    onAdded: (listener: () => void) => { subscribers.add(listener); return () => subscribers.delete(listener); },
    startManyDetailed: async (ids: string[]) => {
      calls.process.push([...ids]);
      const failedIds = ids.filter((id) => id === 'selection-0');
      const startedIds = ids.filter((id) => id !== 'selection-0');
      for (const row of data) if (startedIds.includes(row.id)) { row.status = 'processing'; row.pipelineStage = 'transcribing'; }
      return { startedIds, failedIds };
    },
    delete: async (id: string) => {
      calls.delete.push(id);
      if (id === 'selection-0') throw new Error('Synthetic delete rejection');
      if (id === 'selection-11' || deleted.has(id)) return false;
      deleted.add(id); return true;
    },
    undoDelete: async (id: string) => { calls.undo.push(id); return deleted.delete(id); },
  },
  search: { query: async () => [110, 111].map((index) => ({ meetingId: `selection-${index}`, title: `Synthetic meeting ${index}`, source: 'title', line: 0, text: `Synthetic meeting ${index}` })) },
  pipeline: { status: async () => ({ paused: false, currentId: null, queueLength: 0, queueIds: [] }), onStatusChange: off },
  recording: { onStateChange: off }, meetingDetector: { onDetected: off },
  recovery: { list: async () => [] }, trash: { list: async () => [] },
} as any;

const { librarySelection } = await import('../../electron/renderer/src/lib/selection');
const { useMeetingsStore } = await import('../../electron/renderer/src/store/meetings');
const { LibraryView } = await import('../../electron/renderer/src/views/LibraryView');
const { ToastHost } = await import('../../electron/renderer/src/components/Toasts');
(window as any).fixture = {
  selection: librarySelection, store: useMeetingsStore, calls,
  arrive() {
    data.unshift({ ...data[119]!, id: 'later-arrival', slug: 'later-arrival', title: 'Later synthetic arrival' });
    subscribers.forEach((listener) => listener());
  },
  statusChanged() { data.find((row) => row.id === 'selection-11')!.status = 'done'; },
};
createRoot(document.getElementById('root')!).render(<ToastHost><div style={{ height: '100vh' }}><LibraryView
  onOpen={() => {}} onNav={() => {}} onOpenSearch={() => {}} liveRecording={null}
  onStartRecording={() => { throw new Error('Recording is forbidden in this synthetic fixture'); }} onRecordingStopped={() => {}}
/></div></ToastHost>);
