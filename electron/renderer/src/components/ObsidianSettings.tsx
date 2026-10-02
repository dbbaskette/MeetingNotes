import { useEffect, useRef, useState } from 'react';
import { api } from '../ipc/client';
import type {
  ObsidianOptions,
  ObsidianPreview,
  ObsidianStatus,
  ObsidianComparison,
} from '../../../shared/obsidian';

const button =
  'rounded-md border border-surface-border px-3 py-1.5 text-xs font-semibold hover:bg-surface-sunken focus-visible:ring-2 focus-visible:ring-brand-indigo disabled:opacity-40';
const input = 'rounded-md border border-surface-border bg-surface px-2 py-1.5 text-sm w-full';
const defaults: ObsidianOptions = {
  vault: '',
  folder: 'MeetingNotes',
  actionItems: true,
  transcript: false,
};
export function ObsidianSettings(): JSX.Element {
  const [status, setStatus] = useState<ObsidianStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState(defaults);
  const [preview, setPreview] = useState<ObsidianPreview | null>(null);
  const [comparison, setComparison] = useState<ObsidianComparison | null>(null);
  const [confirm, setConfirm] = useState<'replace' | 'repair' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const modal = useRef<HTMLDialogElement>(null),
    trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    let active = true;
    const refresh = () =>
      void api.obsidian
        .status()
        .then((s) => {
          if (active) setStatus(s);
        })
        .catch((e) => {
          if (active) setError(String(e.message));
        });
    refresh();
    const timer = setInterval(refresh, 3000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    if (open && !modal.current?.open) modal.current?.showModal();
  }, [open]);
  async function perform(action: () => Promise<unknown>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await action();
      setStatus(await api.obsidian.status());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function close(): void {
    if (busy) return;
    if (confirm) {
      setConfirm(null);
      return;
    }
    if (comparison) {
      setComparison(null);
      return;
    }
    modal.current?.close();
    setOpen(false);
    trigger.current?.focus();
  }
  function change(patch: Partial<ObsidianOptions>): void {
    setOptions((o) => ({ ...o, ...patch }));
    setPreview(null);
  }
  const enabled = status?.config?.enabled;
  return (
    <section
      aria-label="Obsidian sync settings"
      className="rounded-xl border border-surface-border p-4 space-y-3"
    >
      <div className="flex flex-wrap gap-3 justify-between items-center">
        <div>
          <h2 className="font-semibold">Obsidian sync</h2>
          <p className="text-xs text-ink-muted">
            {enabled
              ? status?.running
                ? 'Syncing…'
                : `${status?.synced ?? 0} meetings synced · ${status?.pending ?? 0} queued`
              : 'Automatic sync is off'}
          </p>
        </div>
        <button
          ref={trigger}
          className={button}
          onClick={() => {
            const c = status?.config;
            setOptions(
              c
                ? {
                    vault: c.vault,
                    folder: c.folder,
                    actionItems: c.actionItems,
                    transcript: c.transcript,
                  }
                : defaults,
            );
            setPreview(null);
            setComparison(null);
            setConfirm(null);
            setOpen(true);
          }}
        >
          Configure…
        </button>
      </div>
      {status?.lastSuccess && (
        <p className="text-xs text-ink-muted">
          Last successful sync: {new Date(status.lastSuccess).toLocaleString()}
        </p>
      )}
      {error || status?.error || status?.issues.length ? (
        <p role="status" className="text-xs text-danger">
          {error ||
            status?.error ||
            `${status?.issues.length} notes need review. Open Configure for details.`}
        </p>
      ) : null}
      {open && (
        <dialog
          ref={modal}
          aria-labelledby="obsidian-title"
          onCancel={(e) => {
            e.preventDefault();
            close();
          }}
          className="m-auto w-[calc(100%-2rem)] max-w-2xl max-h-[calc(100dvh-2rem)] rounded-xl border border-surface-border bg-surface text-ink p-0 shadow-pop backdrop:bg-black/30 open:flex open:flex-col"
        >
          <header className="flex shrink-0 justify-between items-center border-b border-surface-border p-5">
            <h2 id="obsidian-title" className="font-semibold">
              Obsidian sync
            </h2>
            <button className={button} disabled={busy} onClick={close}>
              Close
            </button>
          </header>
          <div className="p-5 space-y-4 overflow-y-auto min-h-0">
            {error && (
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
            )}
            {confirm ? (
              <div
                role="alertdialog"
                aria-label={confirm === 'repair' ? 'Recreate views?' : 'Replace generated content?'}
                className="space-y-4"
              >
                <p className="text-sm">
                  {confirm === 'repair'
                    ? 'Recreate the landing page, Base, and Browse index? Customized versions will be saved as .backup files first. Meeting notes will not be replaced.'
                    : 'Replace only the generated section and meeting properties with the latest MeetingNotes version? Personal notes and other properties are preserved, and the current file is saved as a .backup first.'}
                </p>
                <button className={button} disabled={busy} onClick={() => setConfirm(null)}>
                  Cancel
                </button>{' '}
                <button
                  className={button}
                  disabled={busy}
                  onClick={() =>
                    void perform(async () => {
                      if (confirm === 'repair') await api.obsidian.repair();
                      else {
                        await api.obsidian.replace(comparison!.id, comparison!.revision);
                        setComparison(null);
                      }
                      setConfirm(null);
                    })
                  }
                >
                  {confirm === 'repair'
                    ? 'Back up and recreate views'
                    : 'Back up and replace generated content'}
                </button>
              </div>
            ) : comparison ? (
              <div className="space-y-3">
                <p className="text-sm">
                  Review the external edit before updating. Edits made in Obsidian do not sync back
                  to MeetingNotes.
                </p>
                <label className="block text-xs">
                  Current vault note
                  <textarea
                    readOnly
                    className={`${input} mt-1 h-36 font-mono`}
                    value={comparison.current}
                  />
                </label>
                <label className="block text-xs">
                  Latest MeetingNotes version
                  <textarea
                    readOnly
                    className={`${input} mt-1 h-36 font-mono`}
                    value={comparison.proposed}
                  />
                </label>
                <div className="flex flex-wrap gap-2">
                  <button className={button} onClick={() => setComparison(null)}>
                    Back
                  </button>
                  <button
                    className={button}
                    disabled={busy}
                    onClick={() => void perform(() => api.obsidian.exportComparison(comparison.id))}
                  >
                    Save latest as…
                  </button>
                  <button
                    className={button}
                    disabled={busy || !comparison.canReplace}
                    onClick={() => setConfirm('replace')}
                  >
                    Replace generated content…
                  </button>
                </div>
                {!comparison.canReplace && (
                  <p className="text-xs text-danger">
                    Ownership or file structure cannot be verified. Restore the original file or
                    compare the saved latest version manually.
                  </p>
                )}
              </div>
            ) : (
              <>
                <p className="text-sm text-ink-muted">
                  One local Markdown note per meeting, with group and date views. Choose the vault
                  root; MeetingNotes creates its own folder inside it.
                </p>
                <p className="text-xs text-ink-muted">
                  One-way sync only. Personal notes are preserved; edits to generated content pause
                  that note. Audio is not copied. If your vault uses Obsidian Sync, iCloud, Git, or
                  another sync service, exported content may leave this Mac.
                </p>
                <form
                  className="space-y-3"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void perform(async () => setPreview(await api.obsidian.preview(options)));
                  }}
                >
                  <fieldset disabled={busy} className="space-y-3">
                    <label className="block text-xs">
                      Vault root folder
                      <div className="flex gap-2 mt-1">
                        <input
                          required
                          className={input}
                          value={options.vault}
                          placeholder="/Users/you/Documents/My vault"
                          onChange={(e) => change({ vault: e.target.value })}
                        />
                        <button
                          type="button"
                          className={button}
                          onClick={() =>
                            void perform(async () => {
                              const vault = await api.obsidian.choose();
                              if (vault) change({ vault });
                            })
                          }
                        >
                          Choose…
                        </button>
                      </div>
                    </label>
                    <label className="block text-xs">
                      MeetingNotes folder name
                      <input
                        required
                        className={`${input} mt-1`}
                        value={options.folder}
                        onChange={(e) => change({ folder: e.target.value })}
                      />
                    </label>
                    <p className="text-xs text-ink-muted break-all">
                      Destination:{' '}
                      {options.vault
                        ? `${options.vault.replace(/\/$/, '')}/${options.folder}`
                        : 'Choose a vault first'}
                    </p>
                    <label className="flex gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={options.actionItems}
                        onChange={(e) => change({ actionItems: e.target.checked })}
                      />
                      Include action items
                    </label>
                    <label className="flex gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={options.transcript}
                        onChange={(e) => change({ transcript: e.target.checked })}
                      />
                      Include transcript
                    </label>
                    <button className={button}>Preview sync</button>
                  </fieldset>
                </form>
                {preview && (
                  <div
                    className="border border-surface-border rounded-lg p-3 space-y-2"
                    role="status"
                  >
                    <p className="text-sm">
                      Sync {preview.meetings} completed meetings to{' '}
                      <span className="break-all">{preview.destination}</span>, then keep future
                      changes updated while MeetingNotes is running.
                    </p>
                    <button
                      className={button}
                      disabled={busy}
                      onClick={() =>
                        void perform(async () => {
                          await api.obsidian.enable(preview.token);
                          setPreview(null);
                        })
                      }
                    >
                      Enable and sync
                    </button>
                  </div>
                )}
                {status?.config && (
                  <div className="border-t border-surface-border pt-4 space-y-3">
                    <p className="text-xs break-all">
                      Active destination: {status.config.vault}/{status.config.folder}
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {enabled && (
                        <button
                          className={button}
                          disabled={busy}
                          onClick={() => void perform(() => api.obsidian.disable())}
                        >
                          Turn off automatic sync
                        </button>
                      )}
                      <button
                        className={button}
                        disabled={busy || !enabled || status.running}
                        onClick={() => void perform(() => api.obsidian.retry())}
                      >
                        Sync now / retry
                      </button>
                      <button
                        className={button}
                        disabled={busy}
                        onClick={() => void perform(() => api.obsidian.open())}
                      >
                        Open folder
                      </button>
                      <button
                        className={button}
                        disabled={busy || status.running}
                        onClick={() => setConfirm('repair')}
                      >
                        Recreate views…
                      </button>
                    </div>
                    <p className="text-xs text-ink-muted">
                      Turning sync off or changing the destination leaves previously exported notes
                      in place. Enable Obsidian’s built-in Bases plugin for the grouped/date views;
                      Browse.md also works without it.
                    </p>
                    {status.error && (
                      <p role="alert" className="text-sm text-danger">
                        {status.error}
                      </p>
                    )}
                    {status.issues.length > 0 && (
                      <div className="max-h-48 overflow-y-auto space-y-2" aria-label="Sync issues">
                        {status.issues.map((issue) => (
                          <div
                            key={issue.id}
                            className="text-xs border-t border-surface-border pt-2"
                          >
                            <p className="font-semibold">{issue.title}</p>
                            <p>{issue.error}</p>
                            <button
                              className={`${button} mt-1`}
                              disabled={busy || status.running}
                              onClick={() =>
                                void perform(async () =>
                                  setComparison(await api.obsidian.compare(issue.id)),
                                )
                              }
                            >
                              Review note
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        </dialog>
      )}
    </section>
  );
}
