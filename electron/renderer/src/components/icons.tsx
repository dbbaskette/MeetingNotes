// electron/renderer/src/components/icons.tsx
//
// Inline SVG icon set (Lucide-style geometry: 24×24 viewBox, stroked with
// currentColor, round caps/joins). Replaces the emoji glyphs (⏺ ⚠︎ 🔒 👤
// 📅 ◈ ▶ ↺) that were previously used as UI icons — emoji render at the
// platform's whim, can't inherit currentColor, and carry inconsistent
// optical weight next to the app's stroked-icon language.
//
// Usage:
//   <Icon name="alert-triangle" className="w-4 h-4" />
//
// Adding an icon: drop the path data into PATHS below. Keep the stroke
// width at 2 and design on the 24px grid so optical weight stays uniform.

const PATHS: Record<string, React.ReactNode> = {
  'record': <circle cx="12" cy="12" r="7" fill="currentColor" stroke="none" />,
  'alert-triangle': (
    <>
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </>
  ),
  'lock': (
    <>
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </>
  ),
  'user': (
    <>
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </>
  ),
  'calendar': (
    <>
      <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
      <line x1="16" y1="2" x2="16" y2="6" />
      <line x1="8" y1="2" x2="8" y2="6" />
      <line x1="3" y1="10" x2="21" y2="10" />
    </>
  ),
  'play': <polygon points="6 3 20 12 6 21 6 3" />,
  'rotate-ccw': (
    <>
      <polyline points="1 4 1 10 7 10" />
      <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
    </>
  ),
  'rotate-cw': (
    <>
      <polyline points="23 4 23 10 17 10" />
      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
    </>
  ),
  'download': (
    <>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </>
  ),
  'mic': (
    <>
      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" y1="19" x2="12" y2="23" />
    </>
  ),
  'brain': (
    <>
      <path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 4.44-1.04Z" />
      <path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-4.44-1.04Z" />
    </>
  ),
  // Replacements for the Unicode glyphs (✓ ✗ ▾ › ⋯ ■ → ← ↓ ✎ ↻ ↦ ○) that
  // were still used as UI icons (#296).
  'check': <polyline points="20 6 9 17 4 12" />,
  'x': <><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></>,
  'chevron-down': <polyline points="6 9 12 15 18 9" />,
  'chevron-right': <polyline points="9 6 15 12 9 18" />,
  'chevron-left': <polyline points="15 6 9 12 15 18" />,
  'more-horizontal': (
    <>
      <circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none" />
    </>
  ),
  'stop': <rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" stroke="none" />,
  'arrow-right': <><line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" /></>,
  'arrow-left': <><line x1="19" y1="12" x2="5" y2="12" /><polyline points="12 19 5 12 12 5" /></>,
  'pencil': <><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" /></>,
  'corner-down-right': <><polyline points="15 10 20 15 15 20" /><path d="M4 4v7a4 4 0 0 0 4 4h12" /></>,
  'circle': <circle cx="12" cy="12" r="8" />,
  'plus': <><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></>,
  'arrow-up-right': <><line x1="7" y1="17" x2="17" y2="7" /><polyline points="7 7 17 7 17 17" /></>,
  'copy': <><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></>,
  'search': <><circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></>,
};

export type IconName = keyof typeof PATHS;

export function Icon({ name, className }: { name: IconName; className?: string }): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className ?? 'w-4 h-4'}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  );
}

/** An icon followed by text, aligned on one line. For labels that used to
 *  start with a glyph ("✓ Granted", "→ Apple Reminders"). */
export function IconLabel({ icon, children, className = '', iconClassName = 'w-3.5 h-3.5 shrink-0' }: {
  icon: IconName; children: React.ReactNode; className?: string; iconClassName?: string;
}): JSX.Element {
  return <span className={`inline-flex items-center gap-1 ${className}`}><Icon name={icon} className={iconClassName} />{children}</span>;
}
