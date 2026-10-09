import { useEffect, useState } from 'react';
import { api } from '../ipc/client';

interface TemplateOption { id: string; name: string; description: string }

const cleanError = (e: unknown): string =>
  (e as Error).message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');

/** Per-meeting template choice for the meeting page's Processing menu (#254).
 *  Choosing a template never rewrites existing notes; it applies the next time
 *  notes are generated. */
export function MeetingTemplatePicker({ meetingId, disabled }: { meetingId: string; disabled?: boolean }): JSX.Element | null {
  const [templates, setTemplates] = useState<TemplateOption[]>([]);
  const [choice, setChoice] = useState<{ own: string | null; group: string | null; effective: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Started inside a promise so a missing bridge method rejects (and shows
    // the inline error) instead of throwing out of the effect.
    void Promise.resolve().then(() => Promise.all([api.summaryTemplates.list(), api.summaryTemplates.forMeeting(meetingId)]))
      .then(([list, current]) => { if (!cancelled) { setTemplates(list.templates); setChoice(current); } })
      .catch((e) => { if (!cancelled) setError(cleanError(e)); });
    return () => { cancelled = true; };
  }, [meetingId]);

  if (error) return <p role="alert" className="text-xs text-danger">Could not load templates: {error}</p>;
  if (!choice || templates.length === 0) return null;
  const nameOf = (id: string): string => templates.find((t) => t.id === id)?.name ?? 'General';
  const inherited = choice.group ? `group default: ${nameOf(choice.group)}` : nameOf('general');

  async function change(value: string): Promise<void> {
    setError(null);
    try {
      await api.summaryTemplates.setForMeeting(meetingId, value === '' ? null : value);
      setChoice(await api.summaryTemplates.forMeeting(meetingId));
    } catch (e) { setError(cleanError(e)); }
  }

  return (
    <label className="block">
      <div className="text-[11px] text-ink-muted font-medium mb-1">Notes template</div>
      <select
        className="input text-xs w-full"
        value={choice.own ?? ''}
        disabled={disabled}
        onChange={(e) => void change(e.target.value)}
      >
        <option value="">Automatic ({inherited})</option>
        {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
      </select>
      <div className="text-[11px] text-ink-muted mt-1">
        {templates.find((t) => t.id === choice.effective)?.description} Applies the next time notes are generated; existing notes are not changed.
      </div>
    </label>
  );
}

/** Default template per group, for Settings → Processing (#254). */
export function GroupTemplateDefaults(): JSX.Element {
  const [templates, setTemplates] = useState<TemplateOption[]>([]);
  const [groups, setGroups] = useState<{ id: string; name: string }[]>([]);
  const [defaults, setDefaults] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(() => Promise.all([api.summaryTemplates.list(), api.groups.list()]))
      .then(([list, snapshot]) => {
        if (cancelled) return;
        setTemplates(list.templates); setDefaults(list.groupDefaults);
        setGroups(snapshot.groups.map(({ id, name }) => ({ id, name })));
      })
      .catch((e) => { if (!cancelled) setError(cleanError(e)); });
    return () => { cancelled = true; };
  }, []);

  async function change(groupId: string, value: string): Promise<void> {
    setError(null);
    const previous = defaults;
    setDefaults((current) => {
      const next = { ...current };
      if (value === '') delete next[groupId]; else next[groupId] = value;
      return next;
    });
    try { await api.summaryTemplates.setForGroup(groupId, value === '' ? null : value); }
    catch (e) { setDefaults(previous); setError(cleanError(e)); }
  }

  return (
    <div className="space-y-2">
      <div className="text-sm text-ink">Notes template by group</div>
      <div className="text-xs text-ink-muted">
        Meetings in a group use its template unless you pick another on the meeting page. Everything else uses General. Changing this affects notes generated from now on.
      </div>
      {error && <p role="alert" className="text-xs text-danger">{error}</p>}
      {groups.length === 0 ? (
        <div className="text-xs text-ink-muted italic">No groups yet. Create one in the Library to give its meetings a default template.</div>
      ) : (
        <ul className="space-y-1.5">
          {groups.map((group) => (
            <li key={group.id} className="flex items-center gap-3">
              <span className="flex-1 min-w-0 truncate text-sm">{group.name}</span>
              <select
                aria-label={`Notes template for ${group.name}`}
                className="input text-xs w-48"
                value={defaults[group.id] ?? ''}
                onChange={(e) => void change(group.id, e.target.value)}
              >
                <option value="">General</option>
                {templates.filter((t) => t.id !== 'general').map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
