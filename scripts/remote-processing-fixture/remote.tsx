import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../electron/renderer/src/index.css';

type Phase = 'offline' | 'uploading' | 'cancelled' | 'conflict' | 'done';
const calls = {
  tested: [] as Array<{ endpoint: string; tokenLength: number }>,
  saved: [] as string[],
  actions: [] as string[],
  resolves: [] as boolean[],
  confirms: 0,
};
let config = {
  mode: 'local' as 'local' | 'remote', endpoint: '', testedAt: null as string | null,
  profile: null as string | null, serviceId: null as string | null, ownerId: null as string | null,
};
let phase: Phase = 'offline';
let phaseRevision = 0;
let confirmDecision = true;
const listeners = new Set<() => void>();
const status = () => ({
  runId: `00000000-0000-4000-8000-${String(phaseRevision).padStart(12, '0')}`,
  phase,
  bytesUploaded: phase === 'uploading' ? 5_242_880 : 0,
  totalBytes: 10_485_760,
  lastContact: '2026-09-09T14:15:00.000Z',
  error: phase === 'offline' ? 'Network unavailable. The accepted run remains queued for reconnect.'
    : phase === 'conflict' ? 'Local content changed after submission.' : null,
  endpoint: 'https://processing.synthetic.invalid',
});

window.confirm = () => { calls.confirms += 1; return confirmDecision; };
window.api = {
  remote: {
    configuration: async () => structuredClone(config),
    test: async (endpoint: string, token: string) => {
      calls.tested.push({ endpoint, tokenLength: token.length });
      if (endpoint !== 'https://processing.synthetic.invalid' || token.length !== 39) throw new Error('Unexpected synthetic connection input');
      config = { mode: 'local', endpoint, testedAt: '2026-09-09T14:00:00.000Z', profile: 'synthetic-v1', serviceId: 'fixture-service', ownerId: 'fixture-owner' };
      return structuredClone(config);
    },
    setMode: async (mode: 'local' | 'remote') => {
      calls.saved.push(mode); config = { ...config, mode }; return structuredClone(config);
    },
    status: async () => structuredClone(status()),
    action: async (_meetingId: string, action: 'retry' | 'cancel' | 'local') => {
      calls.actions.push(action);
      phase = action === 'retry' ? 'uploading' : 'cancelled';
    },
    review: async () => ({
      runId: status().runId,
      kind: 'text_generation',
      summary: '## Remote draft\n\n- Preserve the local edit until the operator chooses.',
      generation: '/private/tmp/meetingnotes-remote-fixture/generation',
      localFingerprint: 'a'.repeat(64),
    }),
    resolve: async (_meetingId: string, _runId: string, accept: boolean) => {
      calls.resolves.push(accept); phase = 'done';
    },
  },
} as any;

const { RemoteProcessingSettings } = await import('../../electron/renderer/src/components/RemoteProcessingSettings');
const { RemoteRunStatus } = await import('../../electron/renderer/src/components/RemoteRunStatus');

function Fixture(): JSX.Element {
  const [meetingId, setMeetingId] = useState(`fixture-${phaseRevision}`);
  React.useEffect(() => {
    const refresh = () => setMeetingId(`fixture-${phaseRevision}`);
    listeners.add(refresh); return () => { listeners.delete(refresh); };
  }, []);
  return <main className="min-h-screen bg-surface text-ink p-8">
    <div className="max-w-2xl mx-auto rounded-xl border border-surface-border bg-surface-raised p-6 space-y-6">
      <h1 className="text-xl font-semibold">Remote processing validation</h1>
      <RemoteProcessingSettings />
      <RemoteRunStatus key={meetingId} meetingId={meetingId} onChanged={() => {}} />
    </div>
  </main>;
}

(window as any).fixture = {
  calls,
  setConfirm(value: boolean) { confirmDecision = value; },
  showPhase(value: Phase) {
    phase = value; phaseRevision += 1; listeners.forEach(listener => listener());
  },
};
createRoot(document.getElementById('root')!).render(<Fixture />);
