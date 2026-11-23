import { useEffect, useState, useRef } from 'react';
import { IconLabel } from './icons';
import { useDialogSurface } from '../lib/dialog-surface';
import { api } from '../ipc/client';

type State = 'granted' | 'denied' | 'not-determined' | 'unknown';

export function PermissionsModal({ onAllGranted }: { onAllGranted: () => void }): JSX.Element {
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogSurface(dialogRef, { busy: true, onClose: () => {} });
  const [mic, setMic] = useState<State>('unknown');
  const [audioCapture, setAudioCapture] = useState<State>('unknown');

  async function recheck(): Promise<void> {
    // Fetch mic state from the authoritative Electron API (queries TCC against
    // the parent app's identity) and audio-capture state from the helper probe
    // in parallel.
    const [micState, audioPerms] = await Promise.all([
      api.permissions.micStatus() as Promise<State>,
      api.permissions.audio() as Promise<{ mic: State; audioCapture: State }>,
    ]);
    setMic(micState); setAudioCapture(audioPerms.audioCapture);
    // Mic granted + audio not explicitly denied → allow recording to start.
    // The OS will prompt for Screen & System Audio Recording automatically
    // the first time the helper attempts a CoreAudio Process Tap capture
    // (i.e. when the user clicks Record).
    if (micState === 'granted' && audioPerms.audioCapture !== 'denied') onAllGranted();
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once on mount; the callback is recreated every render
  useEffect(() => { void recheck(); const t = setInterval(recheck, 2000); return () => clearInterval(t); }, []);

  async function handleGrantMic(): Promise<void> {
    // Calling askForMediaAccess registers MeetingNotes in the Microphone list
    // in System Settings and shows the OS dialog if not yet determined.
    await api.permissions.requestMic();
    // If they denied, open System Settings as a fallback so they can flip it.
    // Use the authoritative micStatus for mic state, helper probe for audioCapture.
    const [micState, audioPerms] = await Promise.all([
      api.permissions.micStatus() as Promise<State>,
      api.permissions.audio() as Promise<{ mic: State; audioCapture: State }>,
    ]);
    setMic(micState); setAudioCapture(audioPerms.audioCapture);
    if (micState !== 'granted') {
      void api.onboarding.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone');
    } else if (audioPerms.audioCapture !== 'denied') {
      onAllGranted();
    }
  }

  return (
    <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="Permissions needed" tabIndex={-1} className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-6">
      <div className="material-dialog bg-surface rounded-2xl shadow-pop max-w-md w-full p-6">
        <h2 className="text-lg font-semibold mb-2">Permissions needed</h2>
        <p className="text-sm text-ink-muted mb-4">
          MeetingNotes records meetings by tapping the microphone and the audio your computer plays. macOS needs your explicit permission for both.
        </p>

        {/* Microphone row */}
        <div className="flex items-center gap-3 py-2 border-t border-surface-border">
          <div className="flex-1">
            <div className="text-sm font-semibold">Microphone</div>
            <div className="text-xs text-ink-muted">
              {mic === 'granted' ? <IconLabel icon="check">Granted</IconLabel> : mic === 'denied' ? <IconLabel icon="x">Denied</IconLabel> : 'Not granted yet'}
            </div>
          </div>
          {mic !== 'granted' && (
            <button
              onClick={() => void handleGrantMic()}
              className="text-xs font-semibold bg-brand-solid text-white px-3 py-1.5 rounded-md"
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
                ? <IconLabel icon="check">Granted</IconLabel>
                : audioCapture === 'denied'
                ? <IconLabel icon="x" className="items-start">Denied — open System Settings → Privacy &amp; Security → Screen &amp; System Audio Recording</IconLabel>
                : (
                  <>
                    macOS will prompt the first time you click Record. If you missed
                    the prompt, open System Settings → Privacy &amp; Security
                    → Screen &amp; System Audio Recording.
                  </>
                )}
            </div>
          </div>
          {audioCapture !== 'granted' && (
            <button
              onClick={() =>
                void api.onboarding.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture')
              }
              className="text-xs font-semibold bg-brand-solid text-white px-3 py-1.5 rounded-md whitespace-nowrap"
            >
              Open System Settings
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
