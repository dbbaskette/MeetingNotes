// electron/renderer/src/components/ConfirmDialog.tsx
//
// Styled confirmation modal for destructive / hard-to-reverse actions.
// Replaces the native `window.confirm` calls that used to guard bulk
// delete, speaker merge, and unsaved-summary discard — those rendered
// un-themed OS chrome that clashed with the app's styled modals
// (DeleteDialog, ExportPickerModal) and blocked the renderer thread.

import { useEffect, useRef } from 'react';
import { ModalShell } from './ModalShell';

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive = false,
  busy = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  body: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Danger styling for the confirm button (deletes, merges, discards). */
  destructive?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}): JSX.Element | null {
  // Esc cancels — matches DeleteDialog and the other modals. Focus the
  // cancel button on open so Enter doesn't immediately fire the
  // destructive action on an impatient second keypress.
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!open) return;
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { e.stopPropagation(); onCancel(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onCancel]);

  if (!open) return null;
  return (
    <ModalShell onClose={onCancel}>
      <div className="text-sm font-semibold mb-2">{title}</div>
      <div className="text-sm text-ink-muted mb-4">{body}</div>
      <div className="flex justify-end gap-2">
        <button
          ref={cancelRef}
          onClick={onCancel}
          className="px-3 py-1.5 text-sm text-ink-muted hover:text-ink rounded-lg"
        >
          {cancelLabel}
        </button>
        <button
          onClick={onConfirm}
          disabled={busy}
          className={`px-3 py-1.5 text-sm font-semibold text-white rounded-lg disabled:opacity-50 ${
            destructive ? 'bg-danger-solid hover:bg-danger-solid' : 'bg-brand-indigo hover:bg-brand-indigo'
          }`}
        >
          {busy ? 'Working…' : confirmLabel}
        </button>
      </div>
    </ModalShell>
  );
}
