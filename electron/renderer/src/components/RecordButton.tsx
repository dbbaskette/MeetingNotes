import { useEffect, useRef, useState } from 'react';
import { api } from '../ipc/client';
import { SourcePicker, type PickedSource } from './SourcePicker';
import { shortcutMod } from '../lib/shortcut';
import { Icon } from './icons';
import type { RecordingStartInput } from '../App';
import { recordingStartFeedback, RECORDING_ACTIVE_MESSAGE, type RecordingStartFeedback } from '../lib/recording-start-feedback';

export function RecordButton({
  onStarted, groupId, active = true, recordingActive = false,
}: {
  onStarted: (info: { sessionId: string; label: string; startInput: RecordingStartInput }) => void;
  groupId?: string | null;
  active?: boolean;
  recordingActive?: boolean;
}): JSX.Element {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [feedback, setFeedback] = useState<RecordingStartFeedback | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);

  useEffect(() => {
    if (recordingActive) setPickerOpen(false);
    setFeedback(null);
  }, [recordingActive]);

  // Listen for the global Cmd+R shortcut dispatched by App.tsx. Toggling
  // the picker (open if closed, close if already open) makes the keystroke
  // both a "start recording" trigger and an "I changed my mind" out, and
  // also wires the shortcut up from any view that mounts the LibraryView.
  useEffect(() => {
    if (!active) return;
    const onToggle = (): void => {
      if (busy) return;
      if (recordingActive) {
        setFeedback({ kind: 'info', message: RECORDING_ACTIVE_MESSAGE });
        return;
      }
      setFeedback(null);
      setPickerOpen((v) => !v);
    };
    window.addEventListener('mn:toggle-record', onToggle);
    return () => window.removeEventListener('mn:toggle-record', onToggle);
  }, [busy, active, recordingActive]);

  async function pick(src: PickedSource): Promise<void> {
    setPickerOpen(false);
    if (pending.current) return;
    if (recordingActive) {
      setFeedback({ kind: 'info', message: RECORDING_ACTIVE_MESSAGE });
      return;
    }
    pending.current = true;
    setBusy(true); setFeedback(null);
    const input: RecordingStartInput = {
      targetPid: src.targetPid, targetLabel: src.targetLabel, mic: true, groupId: src.groupId, title: src.title,
    };
    try {
      const { sessionId } = await api.recording.start(input) as { sessionId: string };
      onStarted({ sessionId, label: src.targetLabel, startInput: input });
    } catch (e) {
      setFeedback(await recordingStartFeedback(e, api.recording));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="relative">
      <button
        onClick={() => { setFeedback(null); setPickerOpen(true); }}
        disabled={busy || recordingActive}
        title={recordingActive ? RECORDING_ACTIVE_MESSAGE : `Start recording (${shortcutMod()}+R)`}
        className="rounded-xl px-5 py-2 text-sm font-semibold text-white shadow-card bg-gradient-to-br from-brand-indigo to-brand-violet disabled:opacity-50 inline-flex items-center gap-2"
      >
        {!busy && <Icon name="record" className="w-3 h-3" />}
        <span>{busy ? 'Starting…' : recordingActive ? 'Recording active' : 'Record'}</span>
        {!busy && !recordingActive && (
          <kbd className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-white/20 text-white/90 hidden sm:inline-block">
            {shortcutMod()}R
          </kbd>
        )}
      </button>
      {pickerOpen && <SourcePicker initialGroupId={groupId} onPick={pick} onCancel={() => setPickerOpen(false)} />}
      {feedback && <div role={feedback.kind === 'info' ? 'status' : 'alert'} className={`text-xs mt-1 max-w-xs ${feedback.kind === 'info' ? 'text-ink-muted' : 'text-danger'}`}>{feedback.message}</div>}
    </div>
  );
}
