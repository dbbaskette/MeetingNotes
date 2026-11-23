// electron/renderer/src/views/settings/OrganizationSettings.tsx
// Organization section: appearance, your identity and the speaker roster.
import { useEffect, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { api } from '../../ipc/client';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { SegmentedControl } from '../../components/SegmentedControl';
import { Icon } from '../../components/icons';
import { Field } from './Field';
import type { EditSetting, Settings, SpeakerListEntry, UpdateSetting } from './types';

export function AppearanceSettings({ s, update }: { s: Settings; update: UpdateSetting }): JSX.Element {
  return (
      <Field label="Appearance">
        <SegmentedControl label="Appearance" size="md" value={s.theme}
          onChange={(opt) => {
            void update('theme', opt).then(saved => {if (saved) window.dispatchEvent(new CustomEvent('mn:theme-changed', { detail: opt }));});
          }}
          options={[{ value: 'system', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]} />
        <div className="text-xs text-ink-muted mt-1">
          System follows macOS appearance. Light and Dark override it.
        </div>
      </Field>
  );
}

export function IdentitySettings({
  s, edit, update, speakers, matchingSpeakers, speakerQuery, setSpeakerQuery, speakerLimit, setSpeakerLimit, refreshSpeakers,
}: {
  s: Settings;
  edit: EditSetting;
  update: UpdateSetting;
  speakers: SpeakerListEntry[];
  matchingSpeakers: SpeakerListEntry[];
  speakerQuery: string;
  setSpeakerQuery: Dispatch<SetStateAction<string>>;
  speakerLimit: number;
  setSpeakerLimit: Dispatch<SetStateAction<number>>;
  refreshSpeakers: () => Promise<void>;
}): JSX.Element {
  return (
    <>
      <Field label="Your name">
        <input
          value={s.userName}
          onChange={(e) => edit('userName', e.target.value)} onBlur={() => void update('userName', s.userName)}
          placeholder="You"
          className="input"
        />
        <div className="text-xs text-ink-muted mt-1">
          Used to label your voice in transcripts when dual-stem capture
          is active. Leave blank to just see &ldquo;You&rdquo;.
        </div>
      </Field>
      <Field label="You are…">
        <select
          value={s.userSpeakerId ?? ''}
          onChange={(e) => update('userSpeakerId', e.target.value === '' ? null : e.target.value)}
          className="input"
        >
          <option value="">— not set —</option>
          {speakers.map((sp) => (
            <option key={sp.id} value={sp.id}>{sp.displayName}</option>
          ))}
        </select>
        <div className="text-xs text-ink-muted mt-1">
          The roster speaker that represents you. When set, the Weekly view
          pins your open action items to the top in a &ldquo;You&rdquo; group.
          Confirm a speaker as yourself in any meeting&rsquo;s Speakers panel
          first to populate this list.
        </div>
      </Field>

      <section className="border-t border-surface-border pt-5">
        <div className="settings-section-title text-ink-muted font-semibold mb-2">Speakers</div>
        <div className="text-xs text-ink-muted mb-3">
          Everyone you&rsquo;ve identified across meetings. Rename fixes a
          misspelling everywhere; merge collapses duplicates (&ldquo;Dan&rdquo; /
          &ldquo;Dan B.&rdquo;) into one person. Both rewrite the affected
          transcripts with the surviving name.
        </div>
        {speakers.length === 0 ? (
          <div className="text-xs text-ink-muted italic">
            No speakers yet — confirm a voice in any meeting&rsquo;s Speakers panel first.
          </div>
        ) : (
          <><input className="input mb-2" aria-label="Find a saved speaker" placeholder="Find a speaker…" value={speakerQuery} onChange={event => { setSpeakerQuery(event.target.value); setSpeakerLimit(10); }} />
          <ul className="space-y-1.5">
            {matchingSpeakers.slice(0, speakerLimit).map((sp) => (
              <SpeakerRosterRow
                key={sp.id}
                speaker={sp}
                others={speakers.filter((o) => o.id !== sp.id)}
                onChanged={refreshSpeakers}
              />
            ))}
          </ul>
          {matchingSpeakers.length > speakerLimit && <button className="text-brand-indigo text-xs mt-2" onClick={() => setSpeakerLimit(limit => limit + 10)}>Show 10 more speakers</button>}
          </>
        )}
      </section>
    </>
  );
}

/** One roster-management row: the speaker's name, an inline ✎ rename, and a
 *  "Merge into…" picker. Rename reuses the existing speakers:rename IPC;
 *  merge confirms first (it deletes this roster entry) then calls
 *  speakers:merge. Both rewrite the affected transcripts in main. */
function SpeakerRosterRow({
  speaker,
  others,
  onChanged,
}: {
  speaker: SpeakerListEntry;
  others: SpeakerListEntry[];
  onChanged: () => Promise<void>;
}): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(speaker.displayName);
  const [busy, setBusy] = useState(false);
  // Pending merge target — non-null while the styled ConfirmDialog (#192)
  // is open. The old window.confirm here rendered un-themed OS chrome.
  const [mergeTarget, setMergeTarget] = useState<SpeakerListEntry | null>(null);
  const [showProfiles, setShowProfiles] = useState(false);
  const [profiles, setProfiles] = useState<Awaited<ReturnType<typeof api.speakers.profiles>>>([]);
  const [profileError, setProfileError] = useState('');
  useEffect(() => {
    if (!showProfiles) return;
    let alive = true;
    void api.speakers.profiles(speaker.id).then(rows => { if (alive) setProfiles(rows); }).catch(error => { if (alive) setProfileError(String(error)); });
    return () => { alive = false; };
  }, [showProfiles, speaker.id]);

  async function saveRename(): Promise<void> {
    const name = draft.trim();
    if (!name || name === speaker.displayName) { setEditing(false); setDraft(speaker.displayName); return; }
    setBusy(true);
    try {
      await api.speakers.rename(speaker.id, name);
      await onChanged();
      setEditing(false);
    } catch (error) { setProfileError(String(error)); } finally {
      setBusy(false);
    }
  }

  async function mergeInto(targetId: string): Promise<void> {
    const target = others.find((o) => o.id === targetId);
    if (!target) return;
    setMergeTarget(target);
  }

  async function confirmMerge(): Promise<void> {
    if (!mergeTarget) return;
    setBusy(true);
    try {
      await api.speakers.merge(speaker.id, mergeTarget.id);
      await onChanged();
    } catch (error) { setProfileError(String(error)); } finally {
      setBusy(false);
      setMergeTarget(null);
    }
  }

  return (
    <li className="flex flex-wrap items-center gap-2 rounded-lg border border-surface-border bg-surface px-3 py-1.5">
      {editing ? (
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void saveRename();
            if (e.key === 'Escape') { setEditing(false); setDraft(speaker.displayName); }
          }}
          onBlur={() => void saveRename()}
          disabled={busy}
          autoFocus
          className="input flex-1 !py-1 text-sm"
          maxLength={200}
        />
      ) : (
        <>
          <span className="flex-1 min-w-0 text-sm text-ink truncate">{speaker.displayName}</span>
          <button
            type="button"
            onClick={() => { setDraft(speaker.displayName); setEditing(true); }}
            disabled={busy}
            title="Rename speaker"
            aria-label={`Rename ${speaker.displayName}`}
            className="text-xs text-ink-muted hover:text-ink px-1.5 py-0.5 rounded transition disabled:opacity-50"
          >
            <Icon name="pencil" className="w-3.5 h-3.5" />
          </button>
        </>
      )}
      <button className="text-xs text-brand-indigo" aria-expanded={showProfiles} onClick={() => setShowProfiles(value => !value)}>Voiceprints</button>
      {/* Merge sits on the row itself; it used to be hidden until the
          Voiceprints drawer was opened (#298). */}
      {others.length > 0 && !editing && (
        <select
          aria-label={`Merge ${speaker.displayName} into another speaker`}
          value=""
          onChange={(e) => { if (e.target.value) void mergeInto(e.target.value); }}
          disabled={busy}
          title={`Merge ${speaker.displayName} into another speaker`}
          className="text-xs text-ink-muted bg-transparent border border-surface-border rounded-md px-1.5 py-0.5 max-w-[9rem] disabled:opacity-50"
        >
          <option value="">Merge into…</option>
          {others.map((o) => (
            <option key={o.id} value={o.id}>{o.displayName}</option>
          ))}
        </select>
      )}
      {showProfiles && <div className="w-full text-xs text-ink-muted space-y-2">
        {!profiles.length && <p>No native voiceprint saved. Confirm this person in a meeting to teach their voice.</p>}
        {profiles.map(profile => <div key={profile.space} className="border-t border-surface-border pt-2">
          <p className="break-words">Native voiceprint · {profile.confirmedAt ? new Date(profile.confirmedAt).toLocaleDateString() : 'Imported profile'}</p>
          <p className="break-words">{profile.source ?? 'Earlier confirmation (source not recorded)'}</p>
          <button className="text-brand-indigo disabled:opacity-40" disabled={busy || !profile.canUndo} onClick={() => {
            setBusy(true); setProfileError('');
            void api.speakers.undoProfile(speaker.id, profile.space).then(() => api.speakers.profiles(speaker.id)).then(setProfiles).catch(error => setProfileError(String(error))).finally(() => setBusy(false));
          }}>Undo last voiceprint change</button>
        </div>)}
        <p>Undo changes future voice matching only. Existing meeting names stay unchanged.</p>
      </div>}
      {profileError && <p role="alert" className="w-full text-xs text-danger">{profileError}</p>}
      <ConfirmDialog
        open={mergeTarget !== null}
        title={`Merge "${speaker.displayName}" into "${mergeTarget?.displayName ?? ''}"?`}
        body={
          <>
            Their meetings and action items move to{' '}
            <span className="font-mono text-ink">{mergeTarget?.displayName}</span>,{' '}
            <span className="font-mono text-ink">{speaker.displayName}</span> is
            removed from the roster, and the affected transcripts are
            rewritten. This can&rsquo;t be undone.
          </>
        }
        confirmLabel="Merge"
        destructive
        busy={busy}
        onConfirm={() => void confirmMerge()}
        onCancel={() => { if (!busy) setMergeTarget(null); }}
      />
    </li>
  );
}
