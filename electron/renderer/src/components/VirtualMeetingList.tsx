import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { retainedRowIndexes, virtualWindow } from '../lib/virtual-window';
import type { MeetingSummary } from '../lib/paged-meetings';
import { RowDialogRetention } from './RowDialogRetention';

// LibraryRow has a 64px minimum height (two text lines + padding/border).
// The remaining 8px is the same inter-row gap used by normal search rows.
const ROW_HEIGHT = 72;
const OVERSCAN = 5;

interface Props {
  items: MeetingSummary[];
  renderRow: (meeting: MeetingSummary) => ReactNode;
  hasMore: boolean;
  loadingMore: boolean;
  refreshing: boolean;
  error: string | null;
  loadMore: () => Promise<void>;
  footer: ReactNode;
  className?: string;
}

/** Browse only: search snippets have variable height and stay non-virtual.
 * Owns the sole scroll container; the footer remains in its normal flow. */
export function VirtualMeetingList({ items, renderRow, hasMore, loadingMore, refreshing, error, loadMore, footer, className = '' }: Props): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ scrollTop: 0, height: 0 });
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [dialogIds, setDialogIds] = useState<Set<string>>(new Set());
  const focusRevision = useRef(0);
  const retainDialog = useCallback((id: string, open: boolean): void => {
    setDialogIds((previous) => {
      if (previous.has(id) === open) return previous;
      const next = new Set(previous);
      if (open) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    let frame: number | null = null;
    const measure = (): void => {
      frame = null;
      const scrollTop = scroll.scrollTop;
      const height = scroll.clientHeight;
      setViewport((previous) => previous.scrollTop === scrollTop && previous.height === height
        ? previous : { scrollTop, height });
    };
    const schedule = (): void => {
      if (frame === null) frame = requestAnimationFrame(measure);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(scroll);
    scroll.addEventListener('scroll', schedule, { passive: true });
    measure();
    return () => {
      observer.disconnect();
      scroll.removeEventListener('scroll', schedule);
      if (frame !== null) cancelAnimationFrame(frame);
      focusRevision.current++;
    };
  }, []);

  const window = virtualWindow({ count: items.length, rowHeight: ROW_HEIGHT, scrollTop: viewport.scrollTop, viewportHeight: viewport.height, overscan: OVERSCAN });
  useEffect(() => {
    // Trigger from the viewport's overscan, never from a distant pinned row.
    // The paged store shares in-flight requests with the explicit button.
    // Errors pause automatic continuation so the retained rows/Retry stay usable.
    if (viewport.height > 0 && items.length > 0 && window.end === items.length && hasMore && !loadingMore && !refreshing && !error) {
      void loadMore();
    }
  }, [window.end, viewport.height, items.length, hasMore, loadingMore, refreshing, error, loadMore]);

  const indexes = retainedRowIndexes({
    items, start: window.start, end: window.end,
    retainedIds: focusedId === null ? dialogIds : [...dialogIds, focusedId],
  });

  return (
    <div ref={scrollRef} className={`flex-1 min-h-0 overflow-y-auto -mr-2 pr-2 ${className}`}>
      <RowDialogRetention.Provider value={retainDialog}>
        <div className="relative" style={{ height: window.totalHeight }}>
          {indexes.map((index) => {
            const meeting = items[index]!;
            return (
              <div
                key={meeting.id}
                className="absolute left-0 right-0"
                style={{ top: index * ROW_HEIGHT, height: ROW_HEIGHT, paddingBottom: 8 }}
                onFocusCapture={() => { focusRevision.current++; setFocusedId(meeting.id); }}
                onBlurCapture={() => {
                  const revision = ++focusRevision.current;
                  // React focus events bubble through portals too. Defer release
                  // so entering a row menu/dialog can renew the same row's pin.
                  queueMicrotask(() => { if (revision === focusRevision.current) setFocusedId(null); });
                }}
              >
                {renderRow(meeting)}
              </div>
            );
          })}
        </div>
      </RowDialogRetention.Provider>
      {footer}
    </div>
  );
}
