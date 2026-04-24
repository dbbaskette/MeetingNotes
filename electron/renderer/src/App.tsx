// electron/renderer/src/App.tsx
import { useEffect, useState } from 'react';
import { LibraryView } from './views/LibraryView';
import { MeetingDetailView } from './views/MeetingDetailView';
import { SettingsView } from './views/SettingsView';
import { PermissionsModal } from './components/PermissionsModal';
import { ToastHost } from './components/Toasts';
import { LiveRecordingRow } from './components/LiveRecordingRow';
import { OnboardingView } from './views/OnboardingView';
import { api } from './ipc/client';

type View = { kind: 'library' } | { kind: 'detail'; id: string } | { kind: 'settings' };
/** Lives at the App level (not inside LibraryView) so navigating between
 *  Library / Detail / Settings doesn't wipe the recording state. The Swift
 *  helper is a separate process and keeps running regardless; this state is
 *  just the UI's memory of "we've got a capture going". */
export interface LiveRecording {
  sessionId: string;
  label: string;
  startedAt: string;
}

export function App(): JSX.Element {
  const [view, setView] = useState<View>({ kind: 'library' });
  const [permsOk, setPermsOk] = useState(true);
  const [liveRecording, setLiveRecording] = useState<LiveRecording | null>(null);
  // Wizard state (#43). `null` = not loaded yet (show nothing),
  // 'needed' = show wizard, 'done' = past onboarding.
  const [onboardStatus, setOnboardStatus] = useState<null | 'needed' | 'done'>(null);
  useEffect(() => {
    void (async () => {
      const all = (await api.settings.getAll()) as { onboardedAt: string | null };
      setOnboardStatus(all.onboardedAt ? 'done' : 'needed');
    })();
  }, []);

  useEffect(() => {
    void (async () => {
      // Use the authoritative Electron mic-status API, not the helper's
      // probe — the helper falsely reports 'granted' because its audio_capture
      // check creates an empty tap which always succeeds. Audio-capture grant
      // is checked at first Record click via the actual Process Tap call.
      const mic = (await api.permissions.micStatus()) as string;
      setPermsOk(mic === 'granted');
    })();
  }, []);

  // If the helper exits on its own (target app quit, parent-watch timeout,
  // idle stop), the main process broadcasts a state change. Clear the UI's
  // live-recording memory so the banner disappears and the next Record
  // click starts fresh.
  useEffect(() => {
    const off = api.recording.onStateChange(({ sessionId, state }) => {
      if (state === 'idle' || state === 'error') {
        setLiveRecording((cur) => (cur?.sessionId === sessionId ? null : cur));
      }
    });
    return () => { off(); };
  }, []);

  const body = onboardStatus === null ? (
    <div className="p-8 text-sm text-ink-muted">Loading…</div>
  ) : onboardStatus === 'needed' ? (
    <OnboardingView onFinished={() => setOnboardStatus('done')} />
  ) : !permsOk ? (
    <PermissionsModal onAllGranted={() => setPermsOk(true)} />
  ) : view.kind === 'library' ? (
    <LibraryView
      onOpen={(id) => setView({ kind: 'detail', id })}
      onSettings={() => setView({ kind: 'settings' })}
      liveRecording={liveRecording}
      onStartRecording={setLiveRecording}
      onRecordingStopped={() => setLiveRecording(null)}
    />
  ) : view.kind === 'detail' ? (
    <MeetingDetailView id={view.id} onBack={() => setView({ kind: 'library' })} />
  ) : (
    <SettingsView onBack={() => setView({ kind: 'library' })} />
  );

  // Persistent recording banner on views that don't show the LibraryView's
  // inline live row. Keeps the user aware that capture is still going even
  // when they've drilled into a meeting or wandered into settings.
  const showTopBanner = liveRecording && view.kind !== 'library';

  return (
    <ToastHost>
      <div className="window-drag-strip" />
      {showTopBanner && (
        <div className="sticky top-0 z-[900] max-w-6xl mx-auto px-6 pt-2">
          <LiveRecordingRow
            sessionId={liveRecording!.sessionId}
            label={liveRecording!.label}
            startedAt={liveRecording!.startedAt}
            onStopped={() => setLiveRecording(null)}
          />
        </div>
      )}
      {body}
    </ToastHost>
  );
}
