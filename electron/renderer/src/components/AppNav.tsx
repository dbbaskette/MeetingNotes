// electron/renderer/src/components/AppNav.tsx
//
// Shared top-level navigation tabs (Library / Weekly / Settings). One
// component rendered in every non-detail view header, replacing the
// per-view duplicated nav markup — Settings used to be reachable only
// from Library's gear icon, which left it undiscoverable from Weekly.
//
// Detail stays a drill-in view with its own back button; the tab strip
// still appears there? No — detail renders its own header chrome. Tab
// clicks route through App's history-aware navigate() (pushes a new
// entry; ⌘[ / ⌘] walk the stack back and forward).

export type NavTarget = 'library' | 'weekly' | 'settings';

const TABS: { target: NavTarget; label: string }[] = [
  { target: 'library', label: 'Library' },
  { target: 'weekly', label: 'Weekly' },
  { target: 'settings', label: 'Settings' },
];

export function AppNav({
  active,
  onNav,
}: {
  active: NavTarget;
  onNav: (target: NavTarget) => void;
}): JSX.Element {
  return (
    <nav className="flex items-center gap-1 text-sm" aria-label="Primary">
      {TABS.map(({ target, label }) => {
        const isActive = target === active;
        return (
          <button
            key={target}
            onClick={() => { if (!isActive) onNav(target); }}
            aria-current={isActive ? 'page' : undefined}
            className={
              isActive
                ? 'px-3 py-1.5 rounded-md bg-surface-sunken text-ink font-medium'
                : 'px-3 py-1.5 rounded-md text-ink-muted hover:text-ink hover:bg-surface-sunken transition'
            }
          >
            {label}
          </button>
        );
      })}
    </nav>
  );
}
