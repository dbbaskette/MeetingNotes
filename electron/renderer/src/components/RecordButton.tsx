import { useEffect, useState } from 'react';
import { api } from '../ipc/client';
import { SourcePicker, type PickedSource } from './SourcePicker';
import { shortcutMod } from '../lib/shortcut';

export function RecordButton({
  onStarted,
}: {
  onStarted: (info: { sessionId: string; label: string }) => void;
}): JSX.Element {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Listen for the global Cmd+R shortcut dispatched by App.tsx. Toggling
  // the picker (open if closed, close if already open) makes the keystroke
  // both a "start recording" trigger and an "I changed my mind" out, and
  // also wires the shortcut up from any view that mounts the LibraryView.
  useEffect(() => {
    const onToggle = (): void => {
      if (busy) return;
      setPickerOpen((v) => !v);
    };
    window.addEventListener('mn:toggle-record', onToggle);
    return () => window.removeEventListener('mn:toggle-record', onToggle);
  }, [busy]);

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
        title={`Start recording (${shortcutMod()}+R)`}
        className="rounded-xl px-5 py-2 text-sm font-semibold text-white shadow-card bg-gradient-to-br from-brand-indigo to-brand-violet disabled:opacity-50 inline-flex items-center gap-2"
      >
        <span>{busy ? 'Starting…' : '⏺ Record'}</span>
        {!busy && (
          <kbd className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-white/20 text-white/90 hidden sm:inline-block">
            {shortcutMod()}R
          </kbd>
        )}
      </button>
      {pickerOpen && <SourcePicker onPick={pick} onCancel={() => setPickerOpen(false)} />}
      {error && <div className="text-xs text-danger mt-1">{error}</div>}
    </div>
  );
}
