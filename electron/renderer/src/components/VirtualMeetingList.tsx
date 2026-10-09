import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { retainedRowIndexes, sectionWindow, settleSectionViewport, stepMeetingIndex, virtualWindow } from '../lib/virtual-window';
import type { MeetingSummary } from '../lib/paged-meetings';
import { RowDialogRetention } from './RowDialogRetention';

// LibraryRow has a 64px minimum height (two text lines + padding/border).
// The remaining 8px is the same inter-row gap used by normal search rows.
const ROW_HEIGHT = 72;
const OVERSCAN = 5;

interface Props {
  scrollRef?: RefObject<HTMLDivElement>;
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
 * Reuses the Library scroll surface, or owns one when rendered standalone.
 * Shared viewport geometry is relative to these rows, not the inbox above. */
export function VirtualMeetingList({ items, renderRow, hasMore, loadingMore, refreshing, error, loadMore, footer, className = '', scrollRef: parentScrollRef }: Props): JSX.Element {
  const ownScrollRef = useRef<HTMLDivElement>(null);
  const scrollRef = parentScrollRef ?? ownScrollRef;
  const rowsRef = useRef<HTMLDivElement>(null);
  const measureFrame = useRef<number | null>(null);
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

  const measure = useCallback((): void => {
    const scroll = scrollRef.current, rows = rowsRef.current;
    if (!scroll || !rows) return;
    const scrollTop = parentScrollRef
      ? scroll.getBoundingClientRect().top + scroll.clientTop - rows.getBoundingClientRect().top
      : scroll.scrollTop;
    setViewport(previous => settleSectionViewport(previous, { scrollTop, height: scroll.clientHeight }));
  }, [scrollRef, parentScrollRef]);
  const schedule = useCallback((): void => {
    if (measureFrame.current === null) measureFrame.current = requestAnimationFrame(() => {
      measureFrame.current = null; measure();
    });
  }, [measure]);
  useLayoutEffect(() => { if (parentScrollRef) schedule(); });
  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const observer = new ResizeObserver(schedule);
    observer.observe(scroll);
    if (parentScrollRef) {
      if (scroll.firstElementChild) observer.observe(scroll.firstElementChild);
      if (rowsRef.current) observer.observe(rowsRef.current);
    }
    scroll.addEventListener('scroll', schedule, { passive: true });
    measure();
    return () => {
      observer.disconnect();
      scroll.removeEventListener('scroll', schedule);
      if (measureFrame.current !== null) cancelAnimationFrame(measureFrame.current);
      measureFrame.current = null;
      // eslint-disable-next-line react-hooks/exhaustive-deps -- the ref is a request counter; cleanup must read its latest value
      focusRevision.current++;
    };
  }, [scrollRef, parentScrollRef, schedule, measure]);

  const window = (parentScrollRef ? sectionWindow : virtualWindow)({ count: items.length, rowHeight: ROW_HEIGHT, scrollTop: viewport.scrollTop, viewportHeight: viewport.height, overscan: OVERSCAN });
  useEffect(() => {
    // Trigger from the viewport's overscan, never from a distant pinned row.
    // The paged store shares in-flight requests with the explicit button.
    // Errors pause automatic continuation so the retained rows/Retry stay usable.
    if (viewport.height > 0 && items.length > 0 && window.end === items.length && hasMore && !loadingMore && !refreshing && !error) {
      void loadMore();
    }
  }, [window.end, viewport.height, items.length, hasMore, loadingMore, refreshing, error, loadMore]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key !== 'j' && key !== 'k') return;
      const target = event.target as HTMLElement | null;
      // Retained Library views can be hidden while detail/Weekly is active.
      // Their global shortcuts must not move the background list or leak
      // through an open portal dialog.
      if (!scrollRef.current?.getClientRects().length || document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
      event.preventDefault();
      const currentIndex = focusedId === null ? null : items.findIndex((item) => item.id === focusedId);
      const next = stepMeetingIndex(items.length, currentIndex === -1 ? null : currentIndex, key === 'j' ? 1 : -1);
      if (next === null) return;
      const id = items[next]!.id;
      setFocusedId(id);
      const scroll = scrollRef.current;
      if (!scroll) return;
      const offset = parentScrollRef && rowsRef.current
        ? rowsRef.current.getBoundingClientRect().top - scroll.getBoundingClientRect().top - scroll.clientTop + scroll.scrollTop : 0;
      const top = offset + next * ROW_HEIGHT;
      if (top < scroll.scrollTop) scroll.scrollTop = top;
      else if (top + ROW_HEIGHT > scroll.scrollTop + scroll.clientHeight) {
        scroll.scrollTop = top + ROW_HEIGHT - scroll.clientHeight;
      }
    };
    globalThis.addEventListener('keydown', onKey);
    return () => globalThis.removeEventListener('keydown', onKey);
  }, [items, focusedId, scrollRef, parentScrollRef]);

  const indexes = retainedRowIndexes({
    items, start: window.start, end: window.end,
    retainedIds: focusedId === null ? dialogIds : [...dialogIds, focusedId],
  });

  return (
    <div ref={ownScrollRef} className={parentScrollRef ? className : `flex-1 min-h-0 overflow-y-auto -mr-2 pr-2 ${className}`}>
      <RowDialogRetention.Provider value={retainDialog}>
        <div ref={rowsRef} className="relative" style={{ height: window.totalHeight }}>
          {indexes.map((index) => {
            const meeting = items[index]!;
            return (
              <div
                key={meeting.id}
                className={`absolute left-0 right-0 ${focusedId === meeting.id ? 'ring-1 ring-brand-indigo/40 rounded-lg z-[1]' : ''}`}
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
