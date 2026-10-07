import { useEffect, useState } from 'react';
import { api } from '../ipc/client';
import type { BackupPreview, BackupStatus } from '../../../shared/backup';
import { ConfirmDialog } from './ConfirmDialog';
export function LibraryBackupPanel(): JSX.Element {
  const [preview, setPreview] = useState<BackupPreview | null>(null),
    [status, setStatus] = useState<BackupStatus>({ state: 'idle', completed: 0, total: 0 }),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!busy || !preview) return;
    let alive = true;
    const timer = setInterval(() => {
      void api.backup
        .status()
        .then((value) => {
          if (alive) setStatus(value);
        })
        .catch(() => {});
    }, 500);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [busy, preview]);
  async function choose(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      setPreview(await api.backup.preview());
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function run(): Promise<void> {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.backup.run(preview.destination);
      setStatus(result);
      if (result.state === 'failed') setError(result.error ?? 'Backup failed');
      setPreview(null);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="rounded-xl border border-surface-border p-4 my-3 space-y-2">
      <h3 className="font-semibold text-sm">Back up Library</h3>
      <p className="text-xs text-ink-muted">
        Save a portable copy of audio, notes, groups, speaker data, history and settings. Model
        caches are excluded. Wait for recording, processing and other saves to finish first.
      </p>
      <button
        type="button"
        disabled={busy}
        onClick={() => void choose()}
        className="text-sm font-semibold text-brand-indigo disabled:opacity-40"
      >
        {busy ? 'Backing up…' : 'Choose backup destination…'}
      </button>
      {busy && status.state === 'working' && (
        <p role="status" className="text-xs">
          {status.completed} / {status.total} files · {status.destination}
        </p>
      )}
      {status.state === 'complete' && (
        <p role="status" className="text-xs text-status-ok">
          Backup validated: {status.destination}
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
      <ConfirmDialog
        open={!!preview}
        title="Back up this Library?"
        busy={busy}
        confirmLabel="Create backup"
        body={
          preview && (
            <>
              <p className="break-all">{preview.destination}</p>
              <p className="mt-2">
                Approximately {(preview.bytes / 1024 / 1024).toFixed(1)} MB · {preview.files} files
              </p>
              <p className="mt-2">
                Contains private meeting audio, notes, speaker names, original paths and settings
                that may contain webhook secrets. Store it privately. Nothing is uploaded.
              </p>
              {preview.missing.length > 0 && (
                <p className="mt-2 text-danger">
                  {preview.missing.length} referenced files are missing. This backup will fail
                  safely until they are located.
                </p>
              )}
            </>
          )
        }
        onCancel={() => setPreview(null)}
        onConfirm={() => void run()}
      />
    </div>
  );
}
