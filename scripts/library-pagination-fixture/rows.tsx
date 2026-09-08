import React, { Profiler, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useStore } from 'zustand';
import { createPagedMeetings, type MeetingSummary } from '../../electron/renderer/src/lib/paged-meetings';
import '../../electron/renderer/src/index.css';

const data: MeetingSummary[] = Array.from({ length: 1000 }, (_, index) => {
  const status = ['done', 'pending', 'processing', 'awaiting_user', 'failed'][index % 5]!;
  return {
    id: `fixture-${index}`, slug: `fixture-${index}`, title: `Meeting ${index} — Long planning session about the quarterly roadmap and delivery milestones`,
    startedAt: '2026-09-08T10:00:00Z', durationS: 5520, pipelineStage: status === 'processing' ? 'transcribing' : status === 'awaiting_user' ? 'awaiting_speaker_id' : status,
    status, stageStartedAt: status === 'processing' ? new Date().toISOString() : null,
    stageEtaMs: null, stageEtaRough: false, unidentifiedCount: 4, actionItemsCount: 3,
    speakers: ['Alice', 'Bob', 'Cameron', 'Daria'].map((name, n) => ({ localLabel: `SPEAKER_${n}`, displayName: name, rosterId: `person-${n}`, confidence: 1 })),
    errorMessage: null, skipSpeakerId: false,
  };
});
const requests: unknown[] = [];
let pending: { resolve: (value: any) => void; reject: (error: Error) => void; response: any } | null = null;
let hold = false;
const counts = { all: 1000, done: 200, pending: 200, processing: 400, failed: 200 };
const store = createPagedMeetings((query) => {
  requests.push(query);
  const start = Number(query.cursor ?? 0);
  const end = Math.min(1000, start + (query.pageSize ?? 50));
  const response = { items: data.slice(start, end), total: 1000, counts, nextCursor: end === 1000 ? null : String(end) };
  if (hold && start > 0) return new Promise((resolve, reject) => { pending = { resolve, reject, response }; });
  return Promise.resolve(response);
});
await store.getState().setQuery({ filter: 'all', sort: 'newest', pageSize: 100 });
while (store.getState().hasMore) await store.getState().loadMore();
requests.length = 0;
const mutations: unknown[] = [];
window.api = { meetings: {
  rename: async (id: string, title: string) => { mutations.push({ rename: id, title }); const row = data.find((row) => row.id === id)!; row.title = title; },
  delete: async (id: string) => { mutations.push({ delete: id }); },
  undoDelete: async () => true,
} } as any;
const { LibraryRow } = await import('../../electron/renderer/src/components/LibraryRow');
const { VirtualMeetingList } = await import('../../electron/renderer/src/components/VirtualMeetingList');
const { ToastHost } = await import('../../electron/renderer/src/components/Toasts');
const plain = new URLSearchParams(location.search).has('plain');
let resetList: () => void;
const fixture = {
  store, requests, mutations, commits: [] as { phase: string; actualDuration: number }[], opened: [] as string[],
  async paging() { hold = true; requests.length = 0; await store.getState().setQuery({ filter: 'all', sort: 'oldest', pageSize: 50 }); resetList(); },
  succeed() { const request = pending!; pending = null; request.resolve(request.response); },
  fail() { const request = pending!; pending = null; request.reject(new Error('Fixture page failure')); },
};
(window as any).fixture = fixture;

function Fixture() {
  const state = useStore(store);
  const [selected, setSelected] = useState(new Set<string>());
  const [key, setKey] = useState(0);
  resetList = () => setKey((value) => value + 1);
  const renderRow = (meeting: MeetingSummary) => <div data-meeting-id={meeting.id}><LibraryRow meeting={meeting}
    onOpen={(id) => { fixture.opened.push(id); }} onChanged={() => { void store.getState().refresh(); }}
    checked={selected.has(meeting.id)} selectionActive={selected.size > 0}
    onToggle={(id) => setSelected((previous) => { const next = new Set(previous); next.has(id) ? next.delete(id) : next.add(id); return next; })} /></div>;
  return <ToastHost><div style={{ maxWidth: 960, margin: '0 auto', padding: 32 }}>
    <h1 style={{ marginBottom: 12 }}>Isolated fixture • 1,000 fake rows • 700px viewport</h1>
    <button id="outside" onClick={() => setSelected(new Set())}>Clear selection / focus outside</button>
    <span id="selection"> Selected: {selected.size}</span>
    <div id="viewport" style={{ height: 700, display: 'flex', flexDirection: 'column', marginTop: 12 }}>
      {plain ? <div className="space-y-2" style={{ overflowY: 'auto' }}>{state.items.map((meeting) => <React.Fragment key={meeting.id}>{renderRow(meeting)}</React.Fragment>)}</div> :
        <VirtualMeetingList key={key} {...state} renderRow={renderRow} className={selected.size ? 'pb-28' : 'pb-8'} footer={
          <div id="footer" style={{ padding: 12, textAlign: 'center' }}>{state.error ? <div role="alert">{state.error} <button onClick={() => void state.retry()}>Retry</button></div> : state.loadingMore ? <span role="status">Loading more meetings…</span> : state.hasMore ? <button onClick={() => void state.loadMore()}>Load more</button> : <span>{state.items.length} of {state.total} meetings</span>}</div>
        } />}
    </div>
  </div></ToastHost>;
}
createRoot(document.getElementById('root')!).render(<Profiler id="rows" onRender={(_id, phase, actualDuration) => fixture.commits.push({ phase, actualDuration })}><Fixture /></Profiler>);
