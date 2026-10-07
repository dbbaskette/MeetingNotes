// electron/renderer/src/components/ModalShell.tsx
//
// Shared modal chrome: full-screen dimmed overlay + centered surface card,
// portaled into document.body. Extracted from MeetingRowMenu so other
// modals (ConfirmDialog, ExportPickerModal-style dialogs) reuse the same
// treatment instead of re-rolling overlay markup.

import { createPortal } from 'react-dom';

export function ModalShell({ children, onClose }: { children: React.ReactNode; onClose: () => void }): JSX.Element {
  // Portal into document.body for the same reason as the dropdown — the
  // row's `hover:-translate-y-px` transform creates a stacking context that
  // also redefines the containing block for any descendant `position: fixed`
  // element. Without the portal, the modal "follows" the row's hover
  // transform instead of the viewport, producing a 1px jitter / flicker as
  // the row's hover state toggles while the mouse moves across the overlay.
  return createPortal(
    <div
      onClick={onClose}
      className="fixed inset-0 z-[1001] bg-black/30 flex items-center justify-center p-4"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-surface rounded-xl shadow-pop border border-surface-border p-5 w-full max-w-md"
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
