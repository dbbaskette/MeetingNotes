// electron/renderer/src/views/LibraryView.tsx
import { useEffect, useState } from 'react';
import { useMeetingsStore } from '../store/meetings';
import { MeetingCard } from '../components/MeetingCard';
import { RecordButton } from '../components/RecordButton';

interface Props {
  onOpen: (id: string) => void;
  onSettings: () => void;
}

export function LibraryView({ onOpen, onSettings }: Props): JSX.Element {
  const { meetings, refresh } = useMeetingsStore();
  const [query, setQuery] = useState('');

  useEffect(() => {
    void refresh();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [refresh]);

  const visible = meetings.filter((m) => m.title.toLowerCase().includes(query.toLowerCase()));

  return (
    <div className="max-w-5xl mx-auto p-8">
      <div className="flex items-center gap-4 mb-6">
        <h1 className="text-lg font-semibold flex-1">MeetingNotes</h1>
        <RecordButton sessionName="Meeting" />
        <button onClick={onSettings} className="text-ink-muted hover:text-ink px-2">
          ⚙
        </button>
      </div>
      <input
        placeholder="Search meetings, speakers, topics…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className="w-full p-3 border border-surface-border rounded-xl mb-4 text-sm"
      />
      {visible.length === 0 && (
        <div className="text-ink-muted text-sm py-8 text-center">
          Hit Record or drop an MP3 in ~/Music/Audio Hijack.
        </div>
      )}
      <div className="space-y-2">
        {visible.map((m) => (
          <MeetingCard key={m.id} meeting={m} onOpen={onOpen} />
        ))}
      </div>
    </div>
  );
}
