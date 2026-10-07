import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../electron/renderer/src/index.css';
const fixture = { picks: [] as unknown[] };
Object.assign(window, { fixture });
window.api = {
  recording: { listSources: async () => [
    ...[501,502].map(pid => ({ pid, name: 'Audio helper', ownerPid: 500, ownerName: 'Zoom', bundleId: 'us.zoom.xos', isUserApp: true, isMeetingApp: true, isRunningOutput: true })),
    { pid: 600, name: 'Teams', bundleId: 'com.microsoft.teams2', isUserApp: true, isMeetingApp: true, isRunningOutput: false },
    { pid: 700, name: 'callservicesd', bundleId: null, isUserApp: false, isMeetingApp: false, isRunningOutput: true },
  ] },
  groups: { list: async () => ({ groups: [{ id: 'g', name: 'Synthetic group', count: 0 }], ungroupedCount: 0 }) },
} as unknown as typeof window.api;
const { SourcePicker } = await import('../../electron/renderer/src/components/SourcePicker');
createRoot(document.getElementById('root')!).render(<div style={{ position: 'relative', width: 500 }}>
  <SourcePicker initialGroupId="g" onCancel={() => {}} onPick={source => fixture.picks.push(source)} />
</div>);
