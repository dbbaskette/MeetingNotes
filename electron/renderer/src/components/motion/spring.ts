// One spring for every animated surface, so the app has a single feel.
export const SPRING = { type: 'spring', stiffness: 420, damping: 36, mass: 0.9 } as const;

export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
