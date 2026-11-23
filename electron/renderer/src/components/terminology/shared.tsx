import type { TermInput } from '../../../../shared/terminology';

export const button =
  'rounded-md border border-surface-border px-3 py-1.5 text-xs font-semibold hover:bg-surface-sunken focus-visible:ring-2 focus-visible:ring-brand-indigo disabled:opacity-40';
export const field =
  'rounded-md border border-surface-border bg-surface px-2 py-1.5 text-sm min-w-0 w-full';
export const defaults: TermInput = {
  source: '',
  replacement: '',
  groupId: null,
  mode: 'suggest',
  caseSensitive: false,
  enabled: true,
};

export function Scope({
  groupId,
  onChange,
  groups,
}: {
  groupId: string | null;
  onChange: (id: string | null) => void;
  groups: { id: string; name: string }[];
}): JSX.Element {
  return (
    <label className="flex items-center gap-2 text-xs">
      Use in
      <select
        className={field}
        value={groupId ?? ''}
        onChange={(e) => onChange(e.target.value || null)}
      >
        <option value="">All meetings</option>
        {groups.map((g) => (
          <option key={g.id} value={g.id}>
            {g.name}
          </option>
        ))}
      </select>
    </label>
  );
}
