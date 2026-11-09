// Compact recording indicator for views that do not show the Library's
// inline recording row. It sits in the title-bar strip and expands in place
// to the full controls (a hand-ported take on Cult UI's Dynamic Island).
import { useEffect, useId, useRef, useState, type ComponentProps } from 'react';
import { m } from 'motion/react';
import { api } from '../../ipc/client';
import { LiveRecordingRow } from '../LiveRecordingRow';
import { useElapsed, fmtElapsed } from '../../lib/useElapsed';
import { SPRING } from './spring';

const BARS = [0.15, 0.45, 0.75];

export function RecordingPill(props: ComponentProps<typeof LiveRecordingRow>): JSX.Element {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const elapsed = useElapsed(props.startedAt, true);
  const [level, setLevel] = useState(0);
  const { sessionId } = props;

  useEffect(() => {
    const off = api.recording.onLevel((event) => {
      if (event.sessionId !== sessionId || (event.source ?? 'mixed') !== 'mixed' || !Number.isFinite(event.peakDb)) return;
      setLevel(Math.min(1, Math.max(0, (event.peakDb + 60) / 60)));
    });
    return () => { off(); };
  }, [sessionId]);

  useEffect(() => {
    if (!open) return;
    // A dialog opened from the controls (restart confirmation) owns Esc and
    // its own backdrop clicks; the pill stays open underneath it.
    const modalOpen = (): boolean => document.querySelector('[role="dialog"][aria-modal="true"]') !== null;
    const onDown = (event: MouseEvent): void => {
      if (!modalOpen() && !root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !modalOpen()) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey); };
  }, [open]);

  const time = elapsed !== null ? fmtElapsed(elapsed) : '0s';
  return (
    <div ref={root} className="fixed top-0.5 left-1/2 z-[950] -translate-x-1/2">
      <button type="button" aria-expanded={open} aria-controls={panelId}
        aria-label={`Recording, ${time}. ${open ? 'Hide' : 'Show'} controls`}
        title={`Recording: ${props.label}`}
        onClick={() => setOpen((value) => !value)}
        className="mx-auto flex h-6 items-center gap-2 rounded-full bg-ink px-3 text-xs font-semibold tabular-nums text-surface shadow-card transition hover:opacity-90">
        <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-danger-solid" />
        <span>{time}</span>
        <span aria-hidden="true" className="flex h-3 items-end gap-0.5">
          {BARS.map((threshold, index) => (
            <span key={threshold} style={{ height: `${40 + index * 30}%` }}
              className={`w-0.5 rounded-full transition-opacity ${level >= threshold ? 'bg-surface opacity-100' : 'bg-surface opacity-30'}`} />
          ))}
        </span>
      </button>
      {/* Stays mounted while collapsed so the row keeps its capture-health
          history; hidden visibility takes it out of tab order and the
          accessibility tree. */}
      {/* The positioning box never takes clicks itself, or it would cover the
          header underneath while the panel is hidden. */}
      <div className="pointer-events-none absolute left-1/2 top-full mt-2 w-[min(36rem,calc(100vw-2rem))] -translate-x-1/2">
        <m.div id={panelId} initial={false} transition={SPRING} style={{ transformOrigin: 'top center', pointerEvents: 'auto' }}
          animate={open
            ? { opacity: 1, scale: 1, y: 0, visibility: 'visible' }
            : { opacity: 0, scale: 0.96, y: -6, transitionEnd: { visibility: 'hidden' } }}
          className="material-dialog rounded-xl bg-surface">
          <LiveRecordingRow {...props} />
        </m.div>
      </div>
    </div>
  );
}
