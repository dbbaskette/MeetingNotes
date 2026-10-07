import React, {useRef, useState, Profiler} from 'react';
import {createRoot} from 'react-dom/client';
import type {MeetingSummary} from '../../electron/renderer/src/lib/paged-meetings';
import '../../electron/renderer/src/index.css';
window.api = {meetings: {rename: async () => {}, delete: async () => {}}} as any;
const {LibraryRow} = await import('../../electron/renderer/src/components/LibraryRow');
const {VirtualGroupRows} = await import('../../electron/renderer/src/components/VirtualGroupRows');
const {ToastHost} = await import('../../electron/renderer/src/components/Toasts');
const rows: MeetingSummary[] = Array.from({length: 3000},(_,i) => ({id: `m-${i}`,slug: `m-${i}`,title: `Planning meeting ${i} — roadmap and delivery milestones`, startedAt: '2026-10-06T10:00:00Z',durationS: 600,pipelineStage: 'done',status: 'done',stageStartedAt: null,stageEtaMs: null,stageEtaRough: false,unidentifiedCount: 0,actionItemsCount: 3,speakers: [],errorMessage: null,skipSpeakerId: false,groupId: null,groupName: null}));
const plain = new URLSearchParams(location.search).has('plain');
const fixture = {commits: [] as number[]}; (window as any).fixture = fixture;
function Fixture() {
  const scrollRef = useRef<HTMLDivElement>(null), [collapsed,setCollapsed] = useState(false);
  const render = (meeting: typeof rows[number]) => <div data-meeting-id={meeting.id}><LibraryRow meeting={meeting} onOpen={() => {}} onChanged={() => {}} onToggle={() => {}}/></div>;
  return <ToastHost><div style={{maxWidth: 960, padding: 32, margin: 'auto'}}>
    <button id="outside">Outside focus</button><button id="collapse" onClick={() => setCollapsed(value => !value)}>Toggle first group</button>
    <div id="viewport" ref={scrollRef} style={{height: 700,overflowY: 'auto'}}><div>
      {[0,1,2].map(group => <section key={group}><h2 style={{height: 56}}>Group {group}</h2>
        {!(group===0 && collapsed) && (plain ? <div className="space-y-2">{rows.slice(group*1000,(group+1)*1000).map(meeting => <React.Fragment key={meeting.id}>{render(meeting)}</React.Fragment>)}</div>
          : <VirtualGroupRows items={rows.slice(group*1000,(group+1)*1000)} scrollRef={scrollRef} renderRow={render}/>)}</section>)}
    </div></div>
  </div></ToastHost>;
}
createRoot(document.getElementById('root')!).render(<Profiler id="grouped" onRender={(_id,_phase,duration) => fixture.commits.push(duration)}><Fixture/></Profiler>);
