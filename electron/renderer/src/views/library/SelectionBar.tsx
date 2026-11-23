// electron/renderer/src/views/library/SelectionBar.tsx
//
// Docked bulk-action bar for the Library selection, moved out of
// LibraryView.tsx unchanged (#256).
import { Icon } from '../../components/icons';

export function SelectionBar({
  count, pendingCount, busy, onProcess, onDelete, onMove, onCancel,
}: {
  count: number;
  /** How many of the selected rows are pending — the Process target.
   *  Process is hidden when it's zero (nothing to start). */
  pendingCount: number | null;
  busy: boolean;
  onProcess: () => void;
  onDelete: () => void;
  onMove: () => void;
  onCancel: () => void;
}): JSX.Element {
  const visible = count > 0;
  if(!visible)return <></>;
  // Anchored `absolute` to the LibraryView root (which fills the shell's
  // flex-1 slot), NOT `fixed` to the viewport — the app-wide status bar
  // occupies the bottom of the viewport and would paint over the pill's
  // bottom edge. The slot ends where the status bar begins, so bottom-0
  // here docks the pill just above it, whatever the status bar's height.
  return (
    <div
      aria-hidden={!visible}
      className={`
        absolute bottom-0 left-0 right-0 z-10 pointer-events-none
        transition-[transform,opacity] duration-200 ease-out
        ${visible ? 'translate-y-0 opacity-100' : 'translate-y-full opacity-0'}
      `}
    >
      <div className="px-4 sm:px-6 lg:px-8 pb-4">
        <div className="pointer-events-auto bg-ink text-surface rounded-xl shadow-pop flex flex-wrap items-center gap-2 sm:gap-3 px-4 py-3">
          <span className="text-sm font-semibold tabular-nums">
            {count} selected · Esc to clear
          </span>
          <div className="flex-1" />
          <button
            onClick={onCancel}
            disabled={busy}
            className="text-sm text-surface/70 hover:text-surface px-3 py-1.5 rounded-lg hover:bg-surface/10 transition"
          >
            Cancel
          </button>
          <button
            onClick={onMove}
            disabled={busy}
            className="text-sm font-semibold text-surface px-3 py-1.5 rounded-lg hover:bg-surface/10 transition disabled:opacity-50"
          >
            Move to group…
          </button>
          <button
            onClick={onDelete}
            disabled={busy}
            className="text-sm font-semibold bg-danger-solid text-white px-4 py-1.5 rounded-lg hover:opacity-90 transition"
          >
            Delete ({count})
          </button>
          {(pendingCount === null || pendingCount > 0) && (
            <button
              onClick={onProcess}
              disabled={busy}
              title="Starts processing the pending recordings in the selection"
              className="text-sm font-semibold bg-brand-solid text-white px-4 py-1.5 rounded-lg hover:bg-brand-solid/90 transition inline-flex items-center gap-1.5"
            >
              <Icon name="play" className="w-3.5 h-3.5" />
              {pendingCount === null ? 'Check & process' : `Process (${pendingCount})`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
