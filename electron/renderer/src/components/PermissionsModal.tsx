import { useEffect, useState } from 'react';
import { api } from '../ipc/client';

type State = 'granted' | 'denied' | 'not-determined' | 'unknown';

export function PermissionsModal({ onAllGranted }: { onAllGranted: () => void }): JSX.Element {
  const [mic, setMic] = useState<State>('unknown');
  const [audioCapture, setAudioCapture] = useState<State>('unknown');

  async function recheck(): Promise<void> {
    const r = (await api.permissions.audio()) as { mic: State; audioCapture: State };
    setMic(r.mic); setAudioCapture(r.audioCapture);
    // Mic granted + audio not explicitly denied → allow recording to start.
    // The OS will prompt for Screen & System Audio Recording automatically
    // the first time the helper attempts a CoreAudio Process Tap capture
    // (i.e. when the user clicks Record).
    if (r.mic === 'granted' && r.audioCapture !== 'denied') onAllGranted();
  }

  useEffect(() => { void recheck(); const t = setInterval(recheck, 2000); return () => clearInterval(t); }, []);

  async function handleGrantMic(): Promise<void> {
    // Calling askForMediaAccess registers MeetingNotes in the Microphone list
    // in System Settings and shows the OS dialog if not yet determined.
    await api.permissions.requestMic();
    // If they denied, open System Settings as a fallback so they can flip it.
    const r = (await api.permissions.audio()) as { mic: State; audioCapture: State };
    setMic(r.mic); setAudioCapture(r.audioCapture);
    if (r.mic !== 'granted') {
      window.open('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone');
    } else if (r.audioCapture !== 'denied') {
      onAllGranted();
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-6">
      <div className="bg-surface rounded-2xl shadow-pop max-w-md w-full p-6">
        <h2 className="text-lg font-semibold mb-2">Permissions needed</h2>
        <p className="text-sm text-ink-muted mb-4">
          MeetingNotes records meetings by tapping the microphone and the audio your computer plays. macOS needs your explicit permission for both.
        </p>

        {/* Microphone row */}
        <div className="flex items-center gap-3 py-2 border-t border-surface-border">
          <div className="flex-1">
            <div className="text-sm font-semibold">Microphone</div>
            <div className="text-xs text-ink-muted">
              {mic === 'granted' ? '✓ Granted' : mic === 'denied' ? '✗ Denied' : 'Not granted yet'}
            </div>
          </div>
          {mic !== 'granted' && (
            <button
              onClick={() => void handleGrantMic()}
              className="text-xs font-semibold bg-brand-indigo text-white px-3 py-1.5 rounded-md"
            >
              Grant
            </button>
          )}
        </div>

        {/* System audio row */}
        <div className="flex items-start gap-3 py-2 border-t border-surface-border">
          <div className="flex-1">
            <div className="text-sm font-semibold">System audio</div>
            <div className="text-xs text-ink-muted">
              {audioCapture === 'granted'
                ? '✓ Granted'
                : audioCapture === 'denied'
                ? '✗ Denied — open System Settings → Privacy & Security → Screen & System Audio Recording'
                : (
                  <>
                    macOS will prompt the first time you click &#9210; Record. If you missed
                    the prompt, click here to open System Settings → Privacy &amp; Security
                    → Screen &amp; System Audio Recording.
                  </>
                )}
            </div>
          </div>
          {audioCapture !== 'granted' && (
            <button
              onClick={() =>
                window.open('x-apple.systempreferences:com.apple.preference.security?Privacy')
              }
              className="text-xs font-semibold bg-brand-indigo text-white px-3 py-1.5 rounded-md whitespace-nowrap"
            >
              {audioCapture === 'denied' ? 'Open Settings' : 'Grant via Record'}
            </button>
          )}
        </div>

        <div className="mt-4 text-xs text-ink-muted">
          After granting microphone access, this dialog will close automatically. System audio
          access is requested automatically when you start your first recording.
        </div>
      </div>
    </div>
  );
}
