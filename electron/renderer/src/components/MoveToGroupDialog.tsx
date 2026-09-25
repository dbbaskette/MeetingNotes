import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../ipc/client';
import { assignGroupInBatches, completedGroupAssignmentIds } from '../lib/group-assignment';
import { filteredMoveDestinations, type GroupDestination } from '../lib/group-move-options';
import { librarySelection } from '../lib/selection';
import { useGroupsStore } from '../store/groups';
import { useToast } from './Toasts';
import { ModalShell } from './ModalShell';

export interface MoveMeetingContext {
  title: string;
  groupId?: string | null;
  groupName?: string | null;
}

export function MoveToGroupDialog({ ids, meeting, hiddenCount = 0, onClose, onChanged }: {
  ids: string[];
  meeting?: MoveMeetingContext;
  /** Bulk selections can contain off-page or collapsed-group meetings. */
  hiddenCount?: number;
  onClose: () => void;
  onChanged: () => void;
}): JSX.Element {
  // Freeze the operation when the dialog opens. A background refresh or a
  // selection change must not silently change what the confirmation moves.
  const [moveIds] = useState(() => [...new Set(ids)]);
  const { groups, loaded, error: groupsError, refresh, create } = useGroupsStore();
  const toast = useToast();
  const [search, setSearch] = useState('');
  const [destination, setDestination] = useState<GroupDestination | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewTitles, setPreviewTitles] = useState<string[]>([]);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (!loaded) void refresh(); }, [loaded, refresh]);
  useEffect(() => {
    if (meeting || moveIds.length === 0) return;
    let active = true;
    void api.meetings.getMany(moveIds.slice(0, 3), { shell: true })
      .then((rows) => { if (active) setPreviewTitles(rows.map((row) => row.title)); })
      .catch(() => { /* the fixed count still identifies the operation */ });
    return () => { active = false; };
  }, [meeting, moveIds]);
  useEffect(() => { input.current?.focus(); }, [creating]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (!busy) onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const destinations = useMemo(() => !loaded || groupsError ? [] :
    filteredMoveDestinations(groups, search), [groups, loaded, groupsError, search]);
  const currentGroup = meeting?.groupId === undefined ? null : meeting.groupName ?? 'Ungrouped';
  const alreadyThere = meeting?.groupId !== undefined && destination?.id === meeting.groupId;
  const destinationMissing = destination !== null && destination.id !== null
    && !groups.some((group) => group.id === destination.id);
  const countLabel = `${moveIds.length} meeting${moveIds.length === 1 ? '' : 's'}`;

  async function applyMove(target: GroupDestination): Promise<void> {
    try {
      const result = await assignGroupInBatches(moveIds, target.id, api.groups.assign);
      const completed = completedGroupAssignmentIds(moveIds, result);
      const moved = result.moved.length;
      const failures = result.failedIds.length;
      const alreadyAssigned = completed.length - moved;
      if (completed.length === 0 && failures > 0) {
        setError(`Could not move ${failures} meeting${failures === 1 ? '' : 's'} to “${target.name}”. Nothing changed; retry or choose another group.`);
        await refresh();
        return;
      }
      await refresh();
      librarySelection.getState().removeSucceeded(completed);
      if (moved > 0) onChanged();
      onClose();
      if (moved === 0) {
        toast.show({
          message: failures
            ? `${alreadyAssigned} already in “${target.name}”; ${failures} still selected for retry.`
            : `Already in “${target.name}”. Selection cleared.`,
          variant: failures ? 'error' : 'default',
        });
        return;
      }
      toast.show({
        message: `${moved} meeting${moved === 1 ? '' : 's'} moved to “${target.name}”${alreadyAssigned ? `; ${alreadyAssigned} already there` : ''}${failures ? `; ${failures} still selected for retry` : ''}.`,
        variant: failures ? 'error' : 'default', durationMs: 10_000,
        action: { label: 'Undo', onClick: async () => {
          const byPrevious = new Map<string | null, string[]>();
          for (const item of result.moved) {
            const list = byPrevious.get(item.previousGroupId) ?? [];
            list.push(item.id); byPrevious.set(item.previousGroupId, list);
          }
          const outcomes = await Promise.allSettled([...byPrevious].map(([previousId, groupIds]) =>
            assignGroupInBatches(groupIds, previousId, api.groups.assign, target.id)));
          const restored = outcomes.reduce((count, outcome) => count +
            (outcome.status === 'fulfilled' ? outcome.value.moved.length : 0), 0);
          await refresh(); onChanged();
          if (restored < moved) toast.show({ message: `Restored ${restored} of ${moved} group assignments.`, variant: 'error' });
        } },
      });
    } catch (cause) {
      setError((cause as Error).message);
    } finally { setBusy(false); }
  }

  async function confirmMove(): Promise<void> {
    if (!destination || moveIds.length === 0 || !loaded || groupsError || alreadyThere || destinationMissing || busy) return;
    setBusy(true); setError(null);
    await applyMove(destination);
  }

  async function createAndMove(): Promise<void> {
    if (!name.trim() || moveIds.length === 0 || !loaded || groupsError || busy) return;
    setBusy(true); setError(null);
    try {
      const group = await create(name);
      const target = { id: group.id, name: group.name };
      setCreating(false);
      setDestination(target);
      await applyMove(target);
    } catch (cause) {
      setError((cause as Error).message);
      setBusy(false);
    }
  }

  return <ModalShell onClose={() => { if (!busy) onClose(); }}>
    <div role="dialog" aria-modal="true" aria-labelledby="move-group-title">
      <h2 id="move-group-title" className="text-base font-semibold">Move {countLabel}</h2>
      <div className="mt-3 rounded-lg bg-surface-sunken px-3 py-2.5 text-sm">
        {meeting ? <>
          <div className="font-semibold truncate" title={meeting.title}>{meeting.title}</div>
          {currentGroup && <div className="mt-0.5 text-xs text-ink-muted">Currently in {currentGroup}</div>}
        </> : <>
          <div className="font-semibold">{countLabel} selected</div>
          {previewTitles.length > 0 && <div className="mt-0.5 text-xs text-ink-muted truncate"
            title={previewTitles.join(', ')}>
            {previewTitles.join(' · ')}{moveIds.length > previewTitles.length ? ` · +${moveIds.length - previewTitles.length} more` : ''}
          </div>}
          {hiddenCount > 0 && <div className="mt-0.5 text-xs text-ink-muted">
            {hiddenCount} selected {hiddenCount === 1 ? 'meeting is' : 'meetings are'} outside the visible list and will also move.
          </div>}
        </>}
      </div>
      <p className="mt-2 text-xs text-ink-muted">Only the Library group changes. Audio and notes stay in place.</p>

      {creating ? <form className="mt-4" onSubmit={(event) => { event.preventDefault(); void createAndMove(); }}>
        <label htmlFor="move-new-group" className="text-sm font-semibold">New destination group</label>
        <input id="move-new-group" ref={input} maxLength={80} value={name} onChange={(event) => setName(event.target.value)}
          disabled={busy} placeholder="Group name"
          className="mt-1.5 w-full rounded-lg border border-surface-border px-3 py-2 text-sm focus:outline-none focus:border-brand-indigo disabled:opacity-50" />
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" disabled={busy} onClick={() => { setCreating(false); setError(null); }}
            className="px-3 py-1.5 text-sm text-ink-muted disabled:opacity-50">Back to groups</button>
          <button type="submit" disabled={busy || moveIds.length === 0 || !loaded || !!groupsError || !name.trim()}
            className="rounded-lg bg-brand-indigo px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50">
            {busy ? 'Creating and moving…' : `Create and move ${countLabel}`}
          </button>
        </div>
      </form> : <>
        <div className="mt-4 text-sm font-semibold">Choose a destination</div>
        <input ref={input} value={search} onChange={(event) => { setSearch(event.target.value); setDestination(null); }}
          placeholder="Find a group…" aria-label="Find a destination group" disabled={busy}
          className="mt-1.5 w-full rounded-lg border border-surface-border bg-surface-sunken px-3 py-2 text-sm focus:outline-none focus:border-brand-indigo disabled:opacity-50" />
        <div role="group" aria-label="Destination groups" className="mt-2 max-h-52 overflow-y-auto space-y-1">
          {!loaded && <div role="status" className="px-3 py-2 text-xs text-ink-muted">Loading groups…</div>}
          {groupsError && <div role="alert" className="px-3 py-2 text-xs text-danger-text">
            Could not load groups. <button type="button" onClick={() => void refresh()} className="font-semibold underline">Retry</button>
          </div>}
          {destinations.map((option) => <button key={option.id ?? 'ungrouped'} type="button" disabled={busy}
            aria-pressed={destination?.id === option.id}
            onClick={() => { setDestination(option); setError(null); }}
            className={`w-full flex items-center gap-3 rounded-lg border px-3 py-2.5 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-indigo/40 disabled:opacity-50
              ${destination?.id === option.id ? 'border-brand-indigo bg-brand-indigo/10 text-brand-indigo' : 'border-transparent hover:border-surface-border hover:bg-surface-sunken'}`}>
            <span aria-hidden="true" className={`h-4 w-4 shrink-0 rounded-full border flex items-center justify-center ${destination?.id === option.id ? 'border-brand-indigo' : 'border-ink-muted/50'}`}>
              {destination?.id === option.id && <span className="h-2 w-2 rounded-full bg-brand-indigo" />}
            </span>
            <span className="min-w-0 flex-1 truncate font-medium" title={option.name}>{option.name}</span>
          </button>)}
          {loaded && !groupsError && destinations.length === 0 && <p className="px-3 py-3 text-xs text-ink-muted">No destination matches “{search}”.</p>}
        </div>
        <button type="button" disabled={busy || !loaded || !!groupsError} onClick={() => { setCreating(true); setDestination(null); setError(null); }}
          className="mt-2 w-full border-t border-surface-border px-3 pt-2 text-left text-sm font-semibold text-brand-indigo disabled:opacity-50">+ New group…</button>
        {destination && <div className="mt-4 rounded-lg border border-brand-indigo/25 bg-brand-indigo/5 px-3 py-2.5 text-sm" role="status">
          <span className="text-ink-muted">Destination</span>
          <span className="mx-2 text-ink-muted" aria-hidden="true">→</span>
          <span className="font-semibold text-brand-indigo break-words">{destination.name}</span>
        </div>}
        {alreadyThere && <p className="mt-2 text-xs text-ink-muted">This meeting is already in that group. Choose a different destination.</p>}
        {destinationMissing && <p className="mt-2 text-xs text-danger-text">That group is no longer available. Choose another destination.</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" disabled={busy} onClick={onClose} className="px-3 py-1.5 text-sm text-ink-muted disabled:opacity-50">Cancel</button>
          <button type="button" disabled={busy || moveIds.length === 0 || !loaded || !!groupsError || !destination || alreadyThere || destinationMissing}
            onClick={() => void confirmMove()}
            aria-label={destination ? `Move ${countLabel} to ${destination.name}` : 'Choose a destination before moving'}
            className="min-w-0 max-w-[65%] rounded-lg bg-brand-indigo px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50">
            <span className="block truncate">{busy ? 'Moving…' : destination ? `Move to ${destination.name}` : 'Choose a group'}</span>
          </button>
        </div>
      </>}
      {error && <p role="alert" className="mt-3 text-xs text-danger-text">{error}</p>}
    </div>
  </ModalShell>;
}
