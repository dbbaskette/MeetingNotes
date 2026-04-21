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
      const r = (await api.permissions.audio()) as { mic: string; audioCapture: string };
      setPermsOk(r.mic === 'granted' && r.audioCapture === 'granted');
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
