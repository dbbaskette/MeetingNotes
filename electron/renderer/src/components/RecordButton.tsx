// electron/renderer/src/components/RecordButton.tsx
import { useState } from 'react';
import { api } from '../ipc/client';

export function RecordButton({ sessionName }: { sessionName: string }): JSX.Element {
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle(): Promise<void> {
    try {
      if (recording) {
        await api.record.stop(sessionName);
        setRecording(false);
      } else {
        await api.record.start(sessionName);
        setRecording(true);
      }
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <>
      <button
        onClick={toggle}
        className={`rounded-xl px-5 py-2 text-sm font-semibold text-white shadow-card
          ${recording ? 'bg-red-500 animate-pulse' : 'bg-gradient-to-br from-brand-indigo to-brand-violet'}`}
      >
        {recording ? '■ Stop' : '⏺ Record'}
      </button>
      {error && <div className="text-xs text-red-600 mt-1">{error}</div>}
    </>
  );
}
