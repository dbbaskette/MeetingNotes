// electron/renderer/src/App.tsx
import { useEffect, useState } from 'react';
import { LibraryView } from './views/LibraryView';
import { MeetingDetailView } from './views/MeetingDetailView';
import { SettingsView } from './views/SettingsView';
import { PermissionsModal } from './components/PermissionsModal';
import { api } from './ipc/client';

type View = { kind: 'library' } | { kind: 'detail'; id: string } | { kind: 'settings' };

export function App(): JSX.Element {
  const [view, setView] = useState<View>({ kind: 'library' });
  const [permsOk, setPermsOk] = useState(true);

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

  if (!permsOk) return <PermissionsModal onAllGranted={() => setPermsOk(true)} />;

  if (view.kind === 'library')
    return (
      <LibraryView
        onOpen={(id) => setView({ kind: 'detail', id })}
        onSettings={() => setView({ kind: 'settings' })}
      />
    );
  if (view.kind === 'detail')
    return <MeetingDetailView id={view.id} onBack={() => setView({ kind: 'library' })} />;
  return <SettingsView onBack={() => setView({ kind: 'library' })} />;
}
