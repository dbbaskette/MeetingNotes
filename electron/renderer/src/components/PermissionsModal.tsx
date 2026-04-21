import { useEffect, useState } from 'react';
import { api } from '../ipc/client';

type State = 'granted' | 'denied' | 'not-determined' | 'unknown';

export function PermissionsModal({ onAllGranted }: { onAllGranted: () => void }): JSX.Element {
  const [mic, setMic] = useState<State>('unknown');
  const [audioCapture, setAudioCapture] = useState<State>('unknown');

  async function recheck(): Promise<void> {
    const r = (await api.permissions.audio()) as { mic: State; audioCapture: State };
    setMic(r.mic); setAudioCapture(r.audioCapture);
    if (r.mic === 'granted' && r.audioCapture === 'granted') onAllGranted();
  }

  useEffect(() => { void recheck(); const t = setInterval(recheck, 2000); return () => clearInterval(t); }, []);

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-6">
      <div className="bg-surface rounded-2xl shadow-pop max-w-md w-full p-6">
        <h2 className="text-lg font-semibold mb-2">Permissions needed</h2>
        <p className="text-sm text-ink-muted mb-4">
          MeetingNotes records meetings by tapping the microphone and the audio your computer plays. macOS needs your explicit permission for both.
        </p>
        <PermRow label="Microphone" state={mic}
          link="x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone" />
        <PermRow label="System audio" state={audioCapture}
          link="x-apple.systempreferences:com.apple.preference.security?Privacy" />
        <div className="mt-4 text-xs text-ink-muted">
          After granting in System Settings, this dialog will close automatically.
        </div>
      </div>
    </div>
  );
}

function PermRow({ label, state, link }: { label: string; state: State; link: string }): JSX.Element {
  return (
    <div className="flex items-center gap-3 py-2 border-t border-surface-border">
      <div className="flex-1">
        <div className="text-sm font-semibold">{label}</div>
        <div className="text-xs text-ink-muted">{state === 'granted' ? '✓ Granted' : state === 'denied' ? '✗ Denied' : 'Not granted yet'}</div>
      </div>
      {state !== 'granted' && (
        <button onClick={() => window.open(link)} className="text-xs font-semibold bg-brand-indigo text-white px-3 py-1.5 rounded-md">
          Grant
        </button>
      )}
    </div>
  );
}
