// electron/renderer/src/components/SegmentedControl.tsx
//
// One segmented control for the whole app (#296). The Library view switch,
// the notes View/Edit switch, the transcript layout switch and the Settings
// appearance picker each used to roll their own markup and colors, and only
// one of them exposed its state to assistive technology. Every instance now
// shares the `.segmented-control` chrome, the gliding selection pill, a
// visible focus ring and `aria-pressed`.

import type { ReactNode } from 'react';
import { SlidingPill } from './motion/SlidingPill';

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  /** Tooltip, for options whose label needs explaining. */
  title?: string;
}

export function SegmentedControl<T extends string>({ label, value, onChange, options, size = 'sm', disabled = false, className = '' }: {
  /** Accessible name for the group, e.g. "Library view". */
  label: string;
  value: T;
  onChange: (value: T) => void;
  options: readonly SegmentedOption<T>[];
  size?: 'sm' | 'md';
  disabled?: boolean;
  className?: string;
}): JSX.Element {
  const padding = size === 'md' ? 'px-4 py-1.5 text-sm' : 'px-2.5 py-1 text-xs';
  return (
    <div role="group" aria-label={label}
      className={`segmented-control inline-flex rounded-lg border border-surface-border p-0.5 ${className}`}>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button key={option.value} type="button" aria-pressed={selected} disabled={disabled} title={option.title}
            onClick={() => { if (!selected) onChange(option.value); }}
            className={`relative rounded-md font-semibold transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-indigo/40 ${padding} ${selected ? 'text-ink' : 'text-ink-muted hover:text-ink'}`}>
            {selected && <SlidingPill group={`segmented:${label}`} className="inset-y-0 pill-surface" />}
            <span className="relative">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
