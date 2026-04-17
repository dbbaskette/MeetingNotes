// electron/renderer/src/App.tsx
import { useState } from 'react';
import { LibraryView } from './views/LibraryView';
import { MeetingDetailView } from './views/MeetingDetailView';
import { SettingsView } from './views/SettingsView';

type View = { kind: 'library' } | { kind: 'detail'; id: string } | { kind: 'settings' };

export function App(): JSX.Element {
  const [view, setView] = useState<View>({ kind: 'library' });
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
