// electron/renderer/src/components/ModalShell.tsx
//
// Shared modal chrome: full-screen dimmed overlay + centered surface card,
// portaled into document.body. Extracted from MeetingRowMenu so other
// modals (ConfirmDialog, ExportPickerModal-style dialogs) reuse the same
// treatment instead of re-rolling overlay markup.

import { createPortal } from 'react-dom';
import { useRef, useContext } from 'react';
import { DialogDepth, useDialogSurface } from '../lib/dialog-surface';

const SIZES = { md: 'max-w-md', lg: 'max-w-2xl', xl: 'max-w-5xl' } as const;

export function ModalShell({ children, onClose, title = 'Meeting action', busy = false, size = 'md', labelledBy, className = 'p-5' }: {
  children: React.ReactNode; onClose: () => void; title?: string; busy?: boolean;
  /** Card width: md for confirmations, lg for editors, xl for side-by-side comparisons. */
  size?: keyof typeof SIZES;
  /** Id of a visible heading inside the dialog; used instead of `title` for the accessible name. */
  labelledBy?: string;
  /** Card padding/layout. Defaults to `p-5`; pass your own for a header + scrolling body. */
  className?: string;
}): JSX.Element {
  const root = useRef<HTMLDivElement>(null);
  const depth=useContext(DialogDepth);
  useDialogSurface(root, { onClose, busy, depth });
  // Portal into document.body for the same reason as the dropdown — the
  // row's `hover:-translate-y-px` transform creates a stacking context that
  // also redefines the containing block for any descendant `position: fixed`
  // element. Without the portal, the modal "follows" the row's hover
  // transform instead of the viewport, producing a 1px jitter / flicker as
  // the row's hover state toggles while the mouse moves across the overlay.
  return createPortal(
    <div
      ref={root} role="dialog" aria-modal="true" tabIndex={-1}
      {...(labelledBy ? { 'aria-labelledby': labelledBy } : { 'aria-label': title })}
      onClick={() => { if (!busy) onClose(); }}
      className="fixed inset-0 z-[1001] bg-black/30 flex items-center justify-center p-4"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className={`material-dialog bg-surface text-ink rounded-xl shadow-pop border border-surface-border w-full max-h-[calc(100dvh-2rem)] ${size === 'md' ? 'overflow-y-auto' : ''} ${SIZES[size]} ${className}`}
      >
        <DialogDepth.Provider value={depth+1}>{children}</DialogDepth.Provider>
      </div>
    </div>,
    document.body,
  );
}
