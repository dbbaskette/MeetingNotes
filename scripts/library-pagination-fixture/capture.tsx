import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import '../../electron/renderer/src/index.css';
const fixture = {failStop:true,failRetry:true,state:'recording',stops:0,stopped:0,starts:[] as unknown[],retries:0,reloads:0,holdStop:false,resolveStop:null as null|(()=>void),level:null as any,revision:0};
(window as any).fixture=fixture;
window.api={recording:{onLevel:(cb:any)=>{fixture.level=cb;return()=>{fixture.level=null;};},stop:async()=>{fixture.stops++;if(fixture.holdStop)await new Promise<void>(resolve=>{fixture.resolveStop=resolve;});if(fixture.failStop)throw new Error('Synthetic Stop unavailable');fixture.state='idle';},state:async()=>fixture.state,start:async(input:unknown)=>{fixture.starts.push(input);return{sessionId:'next'};}},
  meetings:{rerun:async()=>{fixture.retries++;if(fixture.failRetry)throw new Error('Synthetic service unavailable');}},
  speakers:{list:async()=>[{id:'dan',displayName:'Dan'}],sample:async()=>null,suggestions:async()=>[],assignBulk:async()=>{}},
} as any;
const {LiveRecordingRow}=await import('../../electron/renderer/src/components/LiveRecordingRow');
const {FailureBanner}=await import('../../electron/renderer/src/views/MeetingDetailView');
const {SpeakersPanel}=await import('../../electron/renderer/src/views/MeetingSpeakersPanel');
const meeting:any={id:'fixture',status:'failed',pipelineStage:'summarizing',errorMessage:'fetch failed ECONNREFUSED',processingHistory:[{createdAt:'2026-10-07T00:00:00Z',kind:'failure',stage:'summarizing',message:'Synthetic historical failure'}],speakers:Array.from({length:9},(_,i)=>({localLabel:`SPEAKER_0${i}`,displayName:null,rosterId:null,confidence:0.2,needsReview:true,state:'unassigned',durationS:10,lineCount:2}))};
function Fixture():JSX.Element {
  const [show,setShow]=useState(true),[revision,setRevision]=useState(0);
  return <main className="p-5 space-y-5"><button onClick={()=>{setShow(true);setRevision(v=>v+1);}}>Reset live fixture</button><button onClick={()=>setShow(false)}>Unmount live fixture</button>
    {show&&<LiveRecordingRow key={revision} sessionId="capture" label="Synthetic app" title="Preserved meeting title" startedAt={new Date(Date.now()-40000).toISOString()} groupId="preserved-group" onStopped={()=>{fixture.stopped++;setShow(false);}} onRestarted={()=>{fixture.reloads++;}}/>}
    <FailureBanner meeting={meeting} onReload={async()=>{fixture.reloads++;}}/>
    <div style={{maxWidth:480}}><SpeakersPanel meeting={meeting} compact onReload={async()=>{fixture.reloads++;}}/></div><div id="meeting-speakers" tabIndex={-1}>Full roster target</div>
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
