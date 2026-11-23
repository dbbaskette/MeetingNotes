import { Children, isValidElement, createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from '../ipc/client';
import { SlidingPill } from './motion/SlidingPill';

const sections = ['Recording', 'Processing', 'Organization', 'Integrations', 'Storage', 'Advanced'] as const;
type Section = typeof sections[number];
const visibility = createContext<{ section: Section; query: string }>({ section: 'Recording', query: '' });

export function SettingsNavigation({ children, initialSection }: { children: ReactNode;
  /** Section to open on, and to switch to when it changes (deep links into Settings). */
  initialSection?: Section }): JSX.Element {
  const [section, setSection] = useState<Section>(initialSection ?? 'Recording');
  useEffect(() => { if (initialSection) { setSection(initialSection); setQuery(''); } }, [initialSection]);
  const [query, setQuery] = useState('');
  useEffect(() => {
    const choose = (event: Event): void => {
      const name = (event as CustomEvent<Section>).detail;
      if (sections.includes(name)) { setSection(name); setQuery(''); }
    };
    window.addEventListener('meetingnotes:settings-section', choose);
    return () => window.removeEventListener('meetingnotes:settings-section', choose);
  }, []);
  const normalized = query.trim().toLowerCase();
  const matches = Children.toArray(children).filter(child => isValidElement<{section: string; keywords: string}>(child)
    && `${child.props.section} ${child.props.keywords}`.toLowerCase().includes(normalized)).length;
  return <>
    <div className="settings-navigation shrink-0 px-8 py-3 space-y-3 border-b border-surface-border">
      <input className="input w-full" type="search" aria-label="Search settings" placeholder="Find a setting…" value={query} onChange={e => setQuery(e.target.value)}/>
      <nav aria-label="Settings sections" className="flex flex-wrap gap-1">
        {sections.map(name => <button key={name} type="button" aria-pressed={!query && section === name}
          className={`relative rounded-md px-2 py-1 text-xs font-semibold ${!query && section === name ? 'text-ink' : 'text-ink-muted hover:bg-surface-sunken'}`}
          onClick={() => { setSection(name); setQuery(''); }}>
          {!query && section === name && <SlidingPill group="settings-sections" className="inset-y-0 pill-surface" />}
          <span className="relative">{name}</span></button>)}
      </nav>
      {normalized && <p role="status" className="text-xs text-ink-muted">{matches ? 'Showing matching sections, including advanced settings.' : 'No matching settings. Try audio, summary, vault, or storage.'}</p>}
    </div>
    <visibility.Provider value={{section, query: normalized}}>
      <div className="settings-content flex-1 min-h-0 overflow-y-auto px-8 py-6 space-y-5">
        {!query && <h2 className="text-lg font-semibold">{section}</h2>}{children}
      </div>
    </visibility.Provider>
  </>;
}
/** True while the enclosing SettingsSection is on screen. Sections stay
 *  mounted once opened (so drafts survive a tab switch), which means timers
 *  and polls inside them must check this instead of assuming "mounted =
 *  visible". Defaults to true outside a section. */
const sectionShown = createContext(true);
export function useSettingsSectionShown(): boolean { return useContext(sectionShown); }

export function SettingsSection({ section, keywords, children }: { section: Section; keywords: string; children: ReactNode }): JSX.Element {
  const current = useContext(visibility);
  const shown = current.query ? `${section} ${keywords}`.toLowerCase().includes(current.query) : current.section === section;
  // Mount a section's children the first time it is shown, then keep them
  // (#301). All six tabs used to mount at once behind `hidden`, so opening
  // Settings fetched 500 log rows and started the Obsidian poll for tabs the
  // user never looked at.
  const opened = useRef(shown);
  if (shown) opened.current = true;
  return <div hidden={!shown} className="space-y-5" aria-label={`${section} settings`}>
    {opened.current && <sectionShown.Provider value={shown}>
      {shown && current.query && <h2 className="text-lg font-semibold">{section}</h2>}{children}
    </sectionShown.Provider>}
  </div>;
}

export function PathSetting({ label, value, onApply }: { label: string; value: string; onApply: (value: string) => Promise<boolean> }): JSX.Element {
  const [draft, setDraft] = useState(value);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setDraft(value), [value]);
  async function apply(): Promise<void> {
    setBusy(true);
    try { await onApply(draft); }
    finally { setBusy(false); }
  }
  return <div className="space-y-2">
    <label className="block text-sm">{label}<input className="input mt-1 w-full" value={draft} onChange={e => setDraft(e.target.value)} disabled={busy}/></label>
    <div className="flex gap-2">
      <button className="text-xs font-semibold underline" disabled={busy} onClick={() => void api.settings.chooseFolder().then(chosen => { if (chosen) setDraft(chosen); }).catch(e => setError((e as Error).message))}>Choose folder…</button>
      <button className="text-xs font-semibold rounded-md border border-surface-border px-3 py-1 disabled:opacity-40" disabled={busy || draft === value} onClick={() => void apply()}>{busy ? 'Applying…' : 'Apply path'}</button>
      {draft !== value && <button className="text-xs text-ink-muted" disabled={busy} onClick={() => setDraft(value)}>Cancel</button>}
    </div>
    <p className="text-xs text-ink-muted">Applies after restarting MeetingNotes. This selects a folder; it does not move your existing library or files.</p>
    {value !== draft && <p className="text-xs text-ink-muted break-all">Saved path: {value || '(none)'}</p>}
    {error && <p role="alert" className="text-xs text-danger">{error}</p>}
  </div>;
}
