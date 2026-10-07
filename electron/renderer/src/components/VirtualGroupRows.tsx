import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { MeetingSummary } from '../lib/paged-meetings';
import { retainedRowIndexes, sectionWindow, settleSectionViewport } from '../lib/virtual-window';
import { RowDialogRetention } from './RowDialogRetention';

/** Fixed browse rows reuse the organized library's single scroll surface.
 * Search snippets remain variable-height. Focus/dialog owners stay mounted. */
export function VirtualGroupRows({items, scrollRef, renderRow}: {
  items: MeetingSummary[]; scrollRef: RefObject<HTMLDivElement>; renderRow: (meeting: MeetingSummary) => ReactNode;
}): JSX.Element {
  const listRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({scrollTop: 0, height: 0});
  const [focused, setFocused] = useState<string | null>(null);
  const [dialogs, setDialogs] = useState<Set<string>>(new Set());
  const focusRevision = useRef(0);
  const measureFrame = useRef<number | null>(null);
  const retainDialog = useCallback((id: string, open: boolean) => setDialogs(previous => {
    if (previous.has(id) === open) return previous;
    const next = new Set(previous); if (open) next.add(id); else next.delete(id); return next;
  }), []);
  const measure = useCallback(() => {
    const scroll = scrollRef.current, list = listRef.current;
    if (!scroll || !list) return;
    const top = scroll.getBoundingClientRect().top + scroll.clientTop - list.getBoundingClientRect().top;
    const height = scroll.clientHeight;
    setViewport(previous => settleSectionViewport(previous, {scrollTop: top, height}));
  }, [scrollRef]);
  const scheduleMeasure = useCallback(() => {
    if (measureFrame.current !== null) return;
    measureFrame.current = requestAnimationFrame(() => {measureFrame.current = null; measure();});
  }, [measure]);
  // Never synchronously set state on every commit: measuring changes to the
  // shared flex/scroll layout can otherwise cause a nested React update loop.
  useLayoutEffect(scheduleMeasure);
  useEffect(() => {
    const scroll = scrollRef.current, list = listRef.current;
    if (!scroll || !list) return;
    const observer = new ResizeObserver(scheduleMeasure);
    observer.observe(scroll); observer.observe(list);
    if (scroll.firstElementChild) observer.observe(scroll.firstElementChild);
    scroll.addEventListener('scroll', scheduleMeasure, {passive: true});
    scheduleMeasure();
    return () => {
      observer.disconnect(); scroll.removeEventListener('scroll', scheduleMeasure);
      if (measureFrame.current !== null) cancelAnimationFrame(measureFrame.current);
      measureFrame.current = null;
    };
  }, [scrollRef, scheduleMeasure]);
  const window = sectionWindow({count: items.length, rowHeight: 72, scrollTop: viewport.scrollTop, viewportHeight: viewport.height, overscan: 5});
  const indexes = retainedRowIndexes({items, start: window.start, end: window.end, retainedIds: focused ? [...dialogs, focused] : dialogs});
  return <RowDialogRetention.Provider value={retainDialog}>
    <div ref={listRef} className="relative" style={{height: window.totalHeight}}>
      {indexes.map(index => { const meeting = items[index]!; return <div key={meeting.id} className="absolute left-0 right-0" style={{top: index*72, height: 72, paddingBottom: 8}}
        onFocusCapture={() => {focusRevision.current++; setFocused(meeting.id);}}
        onBlurCapture={() => {const revision = ++focusRevision.current; queueMicrotask(() => {if (revision === focusRevision.current) setFocused(null);});}}>
        {renderRow(meeting)}
      </div>; })}
    </div>
  </RowDialogRetention.Provider>;
}
