import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { rowAt, rowOffsets } from '../lib/variable-window';
function scrollParent(el: HTMLElement): HTMLElement {
  for (let parent = el.parentElement; parent; parent = parent.parentElement)
    if (/auto|scroll/.test(getComputedStyle(parent).overflowY)) return parent;
  return document.documentElement;
}
/** Variable-height window on the detail pane's existing scroll surface. */
export function TranscriptWindow({
  count,
  estimate,
  renderRow,
  active,
  follow,
  jump,
  seekRevision = 0,
  contentRevision,
}: {
  count: number;
  estimate: (i: number) => number;
  renderRow: (i: number) => ReactNode;
  active: number;
  follow: () => boolean;
  jump: { index: number; nonce: number } | null;
  seekRevision?: number;
  contentRevision?: string;
}): JSX.Element {
  const root = useRef<HTMLDivElement>(null),
    cache = useRef(new Map<number, number>()),
    scroll = useRef<HTMLElement | null>(null);
  const [revision, setRevision] = useState(0),
    [viewport, setViewport] = useState({ top: 0, height: 600 }),
    [focused, setFocused] = useState<number | null>(null);
  const frame = useRef<number | null>(null),
    width = useRef(0),
    pendingFocus = useRef<number | null>(null);
  const offsets = useMemo(
    () => rowOffsets(count, estimate, cache.current),
    [count, estimate, revision],
  );
  const positions = useRef(offsets);
  positions.current = offsets;
  const handledSeek = useRef(seekRevision);
  const manualUntil = useRef(0);
  useLayoutEffect(() => {
    cache.current.clear();
    setRevision((value) => value + 1);
  }, [contentRevision]);
  const measure = useCallback(() => {
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      const el = root.current,
        parent = scroll.current;
      if (!el || !parent) return;
      const top =
          parent.getBoundingClientRect().top + parent.clientTop - el.getBoundingClientRect().top,
        height = parent.clientHeight;
      setViewport((previous) =>
        Math.abs(previous.top - top) < 0.5 && previous.height === height
          ? previous
          : { top, height },
      );
    });
  }, []);
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const parent = scrollParent(el);
    scroll.current = parent;
    const observer = new ResizeObserver(() => {
      const next = el.clientWidth;
      if (width.current && Math.abs(width.current - next) > 1) {
        cache.current.clear();
        setRevision((value) => value + 1);
      }
      width.current = next;
      measure();
    });
    observer.observe(el);
    observer.observe(parent);
    parent.addEventListener('scroll', measure, { passive: true });
    const manual = (): void => {
      manualUntil.current = Date.now() + 3000;
    };
    const key = (event: KeyboardEvent): void => {
      if (['PageUp', 'PageDown', 'Home', 'End'].includes(event.key)) manual();
    };
    parent.addEventListener('wheel', manual, { passive: true });
    parent.addEventListener('touchmove', manual, { passive: true });
    parent.addEventListener('pointerdown', manual);
    parent.addEventListener('keydown', key);
    measure();
    return () => {
      observer.disconnect();
      parent.removeEventListener('scroll', measure);
      parent.removeEventListener('wheel', manual);
      parent.removeEventListener('touchmove', manual);
      parent.removeEventListener('pointerdown', manual);
      parent.removeEventListener('keydown', key);
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
    };
  }, [measure]);
  const go = useCallback(
    (index: number, focus = false) => {
      const el = root.current,
        parent = scroll.current;
      if (!el || !parent || index < 0 || index >= count) return;
      const relative =
        el.getBoundingClientRect().top - parent.getBoundingClientRect().top - parent.clientTop;
      parent.scrollTop += relative + positions.current[index]! - parent.clientHeight / 3;
      if (focus) {
        pendingFocus.current = index;
        setFocused(index);
      }
      measure();
    },
    [count, measure],
  );
  const latestFollow = useRef(follow);
  latestFollow.current = follow;
  useEffect(() => {
    if (active >= 0 && Date.now() >= manualUntil.current && latestFollow.current()) go(active);
  }, [active, go]);
  useEffect(() => {
    if (seekRevision !== handledSeek.current) {
      handledSeek.current = seekRevision;
      go(active);
    }
  }, [seekRevision, active, go]);
  useEffect(() => {
    if (jump) go(jump.index, true);
  }, [jump, go]);
  const start = Math.max(0, rowAt(offsets, Math.max(0, viewport.top)) - 8),
    end = Math.min(count, rowAt(offsets, Math.max(0, viewport.top + viewport.height)) + 9);
  const indexes = new Set(Array.from({ length: Math.max(0, end - start) }, (_, i) => i + start));
  if (focused !== null && focused < count) indexes.add(focused);
  useLayoutEffect(() => {
    if (pendingFocus.current !== null) {
      const el = root.current?.querySelector<HTMLElement>(
        `[data-transcript-index="${pendingFocus.current}"] button`,
      );
      if (el) {
        el.focus({ preventScroll: true });
        pendingFocus.current = null;
      }
    }
  });
  const measured = useCallback(
    (index: number, height: number) => {
      if (height <= 0 || Math.abs((cache.current.get(index) ?? -1) - height) < 0.5) return;
      const parent = scroll.current,
        el = root.current;
      if (parent && el) {
        const top =
          parent.getBoundingClientRect().top + parent.clientTop - el.getBoundingClientRect().top;
        if (positions.current[index + 1]! <= top)
          parent.scrollTop += height - (positions.current[index + 1]! - positions.current[index]!);
      }
      cache.current.set(index, height);
      setRevision((value) => value + 1);
      measure();
    },
    [measure],
  );
  return (
    <div
      ref={root}
      className="relative max-w-[80ch] mx-auto"
      style={{ height: offsets[count], overflowAnchor: 'none' }}
    >
      {[...indexes]
        .sort((a, b) => a - b)
        .map((index) => (
          <MeasuredTranscriptRow
            key={index}
            index={index}
            top={offsets[index]!}
            measured={measured}
            onFocus={() => setFocused(index)}
            onBlur={() =>
              queueMicrotask(() => {
                if (
                  !root.current
                    ?.querySelector(`[data-transcript-index="${index}"]`)
                    ?.contains(document.activeElement)
                )
                  setFocused((current) => (current === index ? null : current));
              })
            }
            onArrow={(next) => go(Math.max(0, Math.min(count - 1, next)), true)}
          >
            {renderRow(index)}
          </MeasuredTranscriptRow>
        ))}
    </div>
  );
}
function MeasuredTranscriptRow({
  index,
  top,
  measured,
  children,
  onFocus,
  onBlur,
  onArrow,
}: {
  index: number;
  top: number;
  measured: (i: number, h: number) => void;
  children: ReactNode;
  onFocus: () => void;
  onBlur: () => void;
  onArrow: (i: number) => void;
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(() => measured(index, el.getBoundingClientRect().height));
    observer.observe(el);
    return () => observer.disconnect();
  }, [index, measured]);
  return (
    <div
      ref={ref}
      data-transcript-index={index}
      className="absolute left-0 right-0"
      style={{ top }}
      onFocusCapture={onFocus}
      onBlurCapture={onBlur}
      onKeyDown={(event) => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          event.stopPropagation();
          onArrow(index + (event.key === 'ArrowDown' ? 1 : -1));
        }
      }}
    >
      {children}
    </div>
  );
}
