import { useState } from 'react';
import { api } from '../ipc/client';
import { SourcePicker, type PickedSource } from './SourcePicker';

export function RecordButton({
  onStarted,
}: {
  onStarted: (info: { sessionId: string; label: string }) => void;
}): JSX.Element {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function pick(src: PickedSource): Promise<void> {
    setPickerOpen(false);
    setBusy(true); setError(null);
    try {
      const { sessionId } = await api.recording.start({
        targetPid: src.targetPid, targetLabel: src.targetLabel, mic: true,
      }) as { sessionId: string };
      onStarted({ sessionId, label: src.targetLabel });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative">
      <button
        onClick={() => setPickerOpen(true)}
        disabled={busy}
        className="rounded-xl px-5 py-2 text-sm font-semibold text-white shadow-card bg-gradient-to-br from-brand-indigo to-brand-violet disabled:opacity-50"
      >
        {busy ? 'Starting…' : '⏺ Record'}
      </button>
      {pickerOpen && <SourcePicker onPick={pick} onCancel={() => setPickerOpen(false)} />}
      {error && <div className="text-xs text-red-600 mt-1">{error}</div>}
    </div>
  );
}
