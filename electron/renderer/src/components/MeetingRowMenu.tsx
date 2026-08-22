// A compact "…" actions menu for a row in Inbox or Library. Offers:
//   Rename — inline modal with a text input
//   Delete — inline confirm that also removes the audio file on disk
//
// The menu anchors to the trigger button, which sits at the right edge of
// each row. Clicks bubble-stop so they don't also toggle the surrounding
// row (select / open detail). The refresh callback is fired after each
// mutation so the containing list re-queries.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../ipc/client';
import { useToast } from './Toasts';
import { ModalShell } from './ModalShell';

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
  const [anchor, setAnchor] = useState<
    { top?: number; bottom?: number; right: number } | null
  >(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Position the popover relative to the trigger button via viewport
  // coordinates. The menu renders in a portal on document.body because the
  // row's `transform` (hover:-translate-y-px on LibraryRow) creates a new
  // stacking context, and `z-index` inside a transformed ancestor can't
  // escape it — sibling rows paint over us. Fixed positioning + portal
  // sidesteps the whole issue.
  useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    const rect = btnRef.current.getBoundingClientRect();
    const right = window.innerWidth - rect.right;
    // For rows near the window bottom, open upward — a downward menu would
    // land under the app status bar / window edge, and since the popover
    // dismisses on scroll there'd be no way to ever reach its items.
    // 120px ≈ menu height plus the docked status bar, with margin.
    if (window.innerHeight - rect.bottom < 120) {
      setAnchor({ bottom: window.innerHeight - rect.top + 6, right });
    } else {
      setAnchor({ top: rect.bottom + 6, right });
    }
  }, [open]);

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
    function onScroll(): void { setOpen(false); }
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    // Close on scroll — re-computing the anchor on every scroll event is
    // overkill for an actions menu; just dismiss and let the user click again.
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open]);

  return (
    <>
      <button
        ref={btnRef}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        aria-label="Actions"
        title="Actions"
        className="
          w-9 h-9 rounded-md shrink-0 flex items-center justify-center
          text-ink-muted/60 hover:text-ink hover:bg-surface-sunken
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-indigo/40
          transition
        "
      >
        <svg viewBox="0 0 16 16" className="w-4 h-4" fill="currentColor">
          <circle cx="3" cy="8" r="1.5" /><circle cx="8" cy="8" r="1.5" /><circle cx="13" cy="8" r="1.5" />
        </svg>
      </button>

      {open && anchor && createPortal(
        <div
          ref={menuRef}
          onClick={(e) => e.stopPropagation()}
          style={{
            position: 'fixed',
            top: anchor.top,
            bottom: anchor.bottom,
            right: anchor.right,
            zIndex: 1000,
          }}
          className="
            min-w-[140px]
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
            className="w-full text-left px-3 py-1.5 text-danger hover:bg-danger-bg"
          >
            Delete…
          </button>
        </div>,
        document.body,
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
      {err && <div className="text-xs text-danger mt-2">{err}</div>}
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
  const toast = useToast();

  async function confirm(): Promise<void> {
    setBusy(true); setErr(null);
    try {
      await api.meetings.delete(meeting.id);
      // Offer a quick undo toast (10s) for the "oops, wrong row" case.
      // After the toast is gone, the meeting stays restorable from the
      // Library's "Recently deleted" section for the full 30-day trash
      // retention window.
      toast.show({
        message: `Moved "${meeting.title}" to Recently deleted`,
        action: {
          label: 'Undo',
          onClick: async () => {
            try {
              const restored = await api.meetings.undoDelete(meeting.id);
              if (!restored) {
                toast.show({ message: 'Too late — this meeting has already been purged.', variant: 'error' });
              }
            } catch (e) {
              toast.show({ message: `Undo failed: ${(e as Error).message}`, variant: 'error' });
            } finally {
              onDeleted(); // refresh the list either way
            }
          },
        },
        durationMs: 10_000,
      });
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
        Moves the audio file, transcript, summary, and any exports into
        <strong> Recently deleted</strong>, where you can restore it for
        30 days. After that the files are permanently removed.
      </div>
      {err && <div className="text-xs text-danger mb-2">{err}</div>}
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
          className="px-3 py-1.5 text-sm font-semibold text-white rounded-lg bg-danger-solid hover:bg-danger-solid disabled:opacity-50"
        >
          {busy ? 'Deleting…' : 'Delete'}
        </button>
      </div>
    </ModalShell>
  );
}
