import { useLayoutEffect, useRef } from 'react';
import { prefersReducedMotion } from './spring';

// Last visible box per group. The pill is rendered inside the selected item
// only, so each selection change mounts a new pill; it glides in from here.
// A module map (not a shared layout id) also covers views that each render
// their own copy of a control, such as the primary nav.
const lastBox = new Map<string, DOMRect>();

// A slight overshoot, close to the spring the other surfaces use. The Web
// Animations API leaves no inline styles behind, so an interrupted glide
// can never strand the pill between two items.
const GLIDE: KeyframeAnimationOptions = { duration: 320, easing: 'cubic-bezier(0.3, 1.25, 0.6, 1)' };

export function SlidingPill({ group, className = '' }: { group: string; className?: string }): JSX.Element {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const box = el.getBoundingClientRect();
    if (box.width === 0) return; // inside a hidden view: keep the last visible box
    const previous = lastBox.get(group);
    lastBox.set(group, box);
    // React's development double-run of effects cleans up in the same tick;
    // put the starting box back so the second run still has somewhere to
    // glide from. A real unmount happens later and leaves the map alone.
    let settled = false;
    queueMicrotask(() => { settled = true; });
    const restore = (): void => {
      if (settled) return;
      if (previous) lastBox.set(group, previous); else lastBox.delete(group);
    };
    const moved = previous && (previous.left !== box.left || previous.top !== box.top || previous.width !== box.width);
    if (!previous || !moved || prefersReducedMotion() || typeof el.animate !== 'function') return restore;
    const animation = el.animate([
      { transform: `translate(${previous.left - box.left}px, ${previous.top - box.top}px)`, width: `${previous.width}px` },
      { transform: 'translate(0, 0)', width: `${box.width}px` },
    ], GLIDE);
    return () => { animation.cancel(); restore(); };
  }, [group]);
  return <span ref={ref} aria-hidden="true" className={`sliding-pill pointer-events-none absolute left-0 w-full ${className}`} />;
}
