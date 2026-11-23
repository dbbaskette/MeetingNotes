// electron/renderer/src/views/settings/Field.tsx
import type { ReactNode } from 'react';

export function Field({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  // Per-field labels use a plain sans-serif treatment so they don't
  // compete with section headers (Permissions, Recording quality,
  // Meeting auto-detect) which keep the tracked-monospace style. The
  // form has 15+ field labels — making them all small-caps tracked
  // upper-case turned every label into an attention-grab and made the
  // section headers indistinguishable from fields.
  return (
    <label className="block">
      <div className="text-xs text-ink-muted font-medium mb-1">{label}</div>
      {children}
    </label>
  );
}
