// A compact "…" actions menu for a row in Inbox or Library. Offers:
//   Rename — inline modal with a text input
//   Delete — inline confirm that also removes the audio file on disk
//
// The menu anchors to the trigger button, which sits at the right edge of
// each row. Clicks bubble-stop so they don't also toggle the surrounding
// row (select / open detail). The refresh callback is fired after each
// mutation so the containing list re-queries.
import { useEffect, useRef, useState } from 'react';
import { api } from '../ipc/client';

export interface MeetingRowMenuProps {
  meeting: { id: string; title: string };
  onChanged: () => void;
  /** Optional: called after a successful delete so the detail view can
   *  route back to Library if the deleted meeting is currently open. */
  onDeleted?: (id: string) => void;
}

type ModalKind = null | 'rename' | 'delete';

export function MeetingRowMenu({ meeting, onChanged, onDeleted }: MeetingRowMenuProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [modal, setModal] = useState<ModalKind>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Close the popover on outside click + Escape. Doesn't close the modal —
  // a rename/delete confirmation should ignore stray clicks behind it.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent): void {
      const t = e.target as Node;
      if (menuRef.current?.contains(t) || btnRef.current?.contains(t)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') setOpen(false);
    }
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <>
      <button
        ref={btnRef}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        aria-label="More actions"
        className="
          w-7 h-7 rounded-md shrink-0 flex items-center justify-center
          text-ink-muted/60 hover:text-ink hover:bg-surface-sunken
          transition
        "
      >
        <svg viewBox="0 0 16 16" className="w-4 h-4" fill="currentColor">
          <circle cx="3" cy="8" r="1.5" /><circle cx="8" cy="8" r="1.5" /><circle cx="13" cy="8" r="1.5" />
        </svg>
      </button>

      {open && (
        <div
          ref={menuRef}
          onClick={(e) => e.stopPropagation()}
          className="
            absolute right-2 top-12 z-20 min-w-[140px]
            bg-surface border border-surface-border rounded-lg shadow-pop
            py-1 text-sm
          "
        >
          <button
            onClick={() => { setOpen(false); setModal('rename'); }}
            className="w-full text-left px-3 py-1.5 hover:bg-surface-sunken"
          >
            Rename…
          </button>
          <button
            onClick={() => { setOpen(false); setModal('delete'); }}
            className="w-full text-left px-3 py-1.5 text-rose-600 hover:bg-rose-50"
          >
            Delete…
          </button>
        </div>
      )}

      {modal === 'rename' && (
        <RenameDialog
          meeting={meeting}
          onClose={() => setModal(null)}
          onSaved={() => { setModal(null); onChanged(); }}
        />
      )}

      {modal === 'delete' && (
        <DeleteDialog
          meeting={meeting}
          onClose={() => setModal(null)}
          onDeleted={() => {
            setModal(null);
            onChanged();
            onDeleted?.(meeting.id);
          }}
        />
      )}
    </>
  );
}

function RenameDialog({
  meeting, onClose, onSaved,
}: {
  meeting: { id: string; title: string };
  onClose: () => void;
  onSaved: () => void;
}): JSX.Element {
  const [value, setValue] = useState(meeting.title);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    // Autofocus + select so the user can immediately type a replacement.
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  async function save(): Promise<void> {
    const trimmed = value.trim();
    if (trimmed.length === 0) { setErr('Title cannot be empty.'); return; }
    setBusy(true); setErr(null);
    try {
      await api.meetings.rename(meeting.id, trimmed);
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <ModalShell onClose={onClose}>
      <div className="text-sm font-semibold mb-3">Rename meeting</div>
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); void save(); }
          if (e.key === 'Escape') { e.preventDefault(); onClose(); }
        }}
        className="input"
        maxLength={500}
      />
      {err && <div className="text-xs text-rose-600 mt-2">{err}</div>}
      <div className="flex justify-end gap-2 mt-4">
        <button
          onClick={onClose}
          className="px-3 py-1.5 text-sm text-ink-muted hover:text-ink rounded-lg"
        >
          Cancel
        </button>
        <button
          onClick={() => void save()}
          disabled={busy}
          className="px-3 py-1.5 text-sm font-semibold text-white rounded-lg bg-gradient-to-br from-brand-indigo to-brand-violet disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </ModalShell>
  );
}

function DeleteDialog({
  meeting, onClose, onDeleted,
}: {
  meeting: { id: string; title: string };
  onClose: () => void;
  onDeleted: () => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function confirm(): Promise<void> {
    setBusy(true); setErr(null);
    try {
      await api.meetings.delete(meeting.id);
      onDeleted();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <ModalShell onClose={onClose}>
      <div className="text-sm font-semibold mb-2">Delete this meeting?</div>
      <div className="text-sm text-ink-muted mb-4">
        <span className="font-mono text-ink">{meeting.title}</span>
        <br />
        This removes the audio file on disk, the transcript, summary, and
        any exports. The action can&apos;t be undone.
      </div>
      {err && <div className="text-xs text-rose-600 mb-2">{err}</div>}
      <div className="flex justify-end gap-2">
        <button
          onClick={onClose}
          className="px-3 py-1.5 text-sm text-ink-muted hover:text-ink rounded-lg"
        >
          Cancel
        </button>
        <button
          onClick={() => void confirm()}
          disabled={busy}
          className="px-3 py-1.5 text-sm font-semibold text-white rounded-lg bg-rose-600 hover:bg-rose-700 disabled:opacity-50"
        >
          {busy ? 'Deleting…' : 'Delete'}
        </button>
      </div>
    </ModalShell>
  );
}

function ModalShell({ children, onClose }: { children: React.ReactNode; onClose: () => void }): JSX.Element {
  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 bg-black/30 flex items-center justify-center p-4"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-surface rounded-xl shadow-pop border border-surface-border p-5 w-full max-w-md"
      >
        {children}
      </div>
    </div>
  );
}
