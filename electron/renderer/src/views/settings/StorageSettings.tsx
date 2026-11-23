// electron/renderer/src/views/settings/StorageSettings.tsx
// Storage section: library path, storage map, backups and the extra watch folder.
import { api } from '../../ipc/client';
import { LibraryBackupPanel } from '../../components/LibraryBackupPanel';
import { PathSetting } from '../../components/SettingsNavigation';
import type { Settings, UpdateSetting } from './types';

export function StorageSettings({ s, update }: { s: Settings; update: UpdateSetting }): JSX.Element {
  return (
    <>
      <PathSetting label="Library path" value={s.libraryPath} onApply={value => update('libraryPath', value)}/>
      <StoragePanel />
      <LibraryBackupPanel />
      <PathSetting label="Extra watch folder" value={s.audioWatchPath} onApply={value => update('audioWatchPath', value)}/>
        <div className="text-xs text-ink-muted mt-1">
          Optional. An extra folder watched for dropped audio. Your library&rsquo;s
          recordings folder and the legacy ~/Music/MeetingNotes are always watched.
        </div>
    </>
  );
}

/** Legible storage map (Option B). Recordings, meetings, and the database
 *  live under the Library Path (edited above); re-downloadable / derived data
 *  stays in the conventional macOS locations. The display strings mirror
 *  storageLocations() in electron/main/lib/storage-paths.ts; the Reveal
 *  buttons resolve the real (possibly relocated) paths in the main process. */
function StoragePanel(): JSX.Element {
  const rows: { key: string; label: string; path: string; note: string }[] = [
    {
      key: 'nativeModels', label: 'Native speaker models',
      path: '~/Library/Application Support/MeetingNotes/speech-models',
      note: 'Verified SpeakerKit models. Apple language assets are managed separately by macOS.',
    },
    {
      key: 'logs',
      label: 'Logs',
      path: '~/Library/Logs/MeetingNotes',
      note: 'App logs.',
    },
  ];
  return (
    <div className="rounded-lg border border-surface-border bg-surface-sunken/40 divide-y divide-surface-border">
      <div className="px-3 py-2.5">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-ink flex-1">Library</span>
          <button
            onClick={() => void api.settings.revealStorage('library')}
            className="text-xs font-semibold text-ink-muted hover:text-ink px-2 py-1 rounded-lg border border-surface-border hover:border-ink/30 transition shrink-0"
          >
            Reveal in Finder
          </button>
        </div>
        <div className="text-xs text-ink-muted mt-0.5">
          Recordings, meetings, and the database (Library Path above).
        </div>
      </div>
      {rows.map((r) => (
        <div key={r.key} className="px-3 py-2.5">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-ink flex-1">{r.label}</span>
            <button
              onClick={() => void api.settings.revealStorage(r.key)}
              className="text-xs font-semibold text-ink-muted hover:text-ink px-2 py-1 rounded-lg border border-surface-border hover:border-ink/30 transition shrink-0"
            >
              Reveal in Finder
            </button>
          </div>
          <div className="font-mono text-[11px] text-ink-muted mt-0.5 break-all">{r.path}</div>
          <div className="text-xs text-ink-muted mt-0.5">{r.note}</div>
        </div>
      ))}
    </div>
  );
}
