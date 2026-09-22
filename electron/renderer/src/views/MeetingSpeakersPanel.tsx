import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../ipc/client';
import { colorForSpeakerIndex } from '../theme/tokens';
import { partitionSpeakerReview, speakerReviewLayout } from '../lib/speaker-review-layout';
import type { MeetingDetail } from './MeetingDetailView';

function MiniSpinner(): JSX.Element {
  return <svg viewBox="0 0 16 16" className="w-3.5 h-3.5 animate-spin" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
    <path d="M8 2a6 6 0 1 1-6 6" opacity="0.9" />
  </svg>;
}

interface RosterEntry { id: string; displayName: string; }

export function SpeakersPanel({
  meeting, onReload,
}: {
  meeting: MeetingDetail;
  onReload: () => Promise<void>;
}): JSX.Element {
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  // Bump on every assign/unlink so the roster dropdown re-fetches (newly-
  // created entries appear immediately).
  const [version, setVersion] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkRosterId, setBulkRosterId] = useState('');
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const list = (await api.speakers.list()) as { id: string; displayName: string }[];
      setRoster(list);
    })();
  }, [version]);

  async function reloadMeeting(): Promise<void> {
    // Re-fetch roster (new entries may have been created) AND the meeting
    // detail (so the assigned name shows up immediately without waiting on
    // the parent's polling, which may have stopped after 'done').
    setVersion((v) => v + 1);
    await onReload();
  }

  const selectedImpact = meeting.speakers
    .filter((speaker) => selected.has(speaker.localLabel))
    .reduce((sum, speaker) => sum + (speaker.lineCount ?? 0), 0);
  const groupedSpeakers = useMemo(
    () => partitionSpeakerReview(meeting.speakers.map((speaker, colorIdx) => ({ ...speaker, colorIdx }))),
    [meeting.speakers],
  );
  function toggleSelected(label: string): void {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(label)) next.delete(label); else next.add(label);
      return next;
    });
  }
  async function bulkAssign(): Promise<void> {
    if (!bulkRosterId || selected.size === 0) return;
    setBulkBusy(true); setBulkError(null);
    try {
      await api.speakers.assignBulk({ meetingId: meeting.id, localLabels: [...selected], rosterId: bulkRosterId });
      setSelected(new Set());
      setBulkRosterId('');
      await reloadMeeting();
    } catch (error) {
      setBulkError((error as Error).message);
    } finally {
      setBulkBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between">
        <div className="font-mono text-[11px] tracking-[0.2em] uppercase text-ink-muted font-semibold">Speakers</div>
        {meeting.speakers.length > 0 && (
          <div className="text-[10px] text-ink-muted tabular-nums">
            {meeting.speakers.filter((sp) => sp.rosterId).length}/{meeting.speakers.length} named
          </div>
        )}
      </div>

      {meeting.speakers.length === 0 && (
        <div className="text-xs text-ink-muted italic">
          No speakers yet. Available after diarize + identify.
        </div>
      )}

      {selected.size > 0 && (
        <div className="rounded-lg border border-brand-indigo/30 bg-brand-indigo/5 p-2 space-y-1.5">
          <div className="text-[11px] font-medium text-ink">
            {selected.size} voice{selected.size === 1 ? '' : 's'} selected · {selectedImpact} transcript line{selectedImpact === 1 ? '' : 's'} will change
          </div>
          <div className="flex gap-1.5">
            <select
              value={bulkRosterId}
              disabled={bulkBusy}
              onChange={(event) => setBulkRosterId(event.target.value)}
              className="min-w-0 flex-1 text-xs border border-surface-border rounded-md bg-surface px-2 py-1"
            >
              <option value="">Assign all to…</option>
              {roster.map((entry) => <option key={entry.id} value={entry.id}>{entry.displayName}</option>)}
            </select>
            <button
              disabled={!bulkRosterId || bulkBusy}
              onClick={() => void bulkAssign()}
              className="text-xs font-semibold px-2.5 py-1 rounded-md bg-brand-indigo text-white disabled:opacity-40"
            >
              {bulkBusy ? 'Assigning…' : 'Assign'}
            </button>
          </div>
          {bulkError && <div className="text-[11px] text-danger">{bulkError}</div>}
        </div>
      )}

      <div className="space-y-1.5">
        {groupedSpeakers.needsReview.length > 0 && groupedSpeakers.rest.length > 0 && (
          <div className="text-[10px] uppercase tracking-wider font-semibold text-ink-muted">Needs review</div>
        )}
        {groupedSpeakers.needsReview.map((sp) => (
          <SpeakerRow
            key={sp.localLabel}
            meetingId={meeting.id}
            localLabel={sp.localLabel}
            displayName={sp.displayName}
            rosterId={sp.rosterId}
            confidence={sp.confidence}
            reviewState={sp.state}
            needsReview={sp.needsReview}
            durationS={sp.durationS}
            lineCount={sp.lineCount}
            colorIdx={sp.colorIdx}
            roster={roster}
            isOpen={expanded === sp.localLabel}
            onToggle={() => setExpanded((prev) => (prev === sp.localLabel ? null : sp.localLabel))}
            onChanged={reloadMeeting}
            selectable={sp.needsReview ?? false}
            selected={selected.has(sp.localLabel)}
            onSelect={() => toggleSelected(sp.localLabel)}
          />
        ))}
        {groupedSpeakers.rest.length > 0 && groupedSpeakers.needsReview.length > 0 && (
          <div className="text-[10px] uppercase tracking-wider font-semibold text-ink-muted pt-1">Named</div>
        )}
        {groupedSpeakers.rest.map((sp) => (
          <SpeakerRow
            key={sp.localLabel}
            meetingId={meeting.id}
            localLabel={sp.localLabel}
            displayName={sp.displayName}
            rosterId={sp.rosterId}
            confidence={sp.confidence}
            reviewState={sp.state}
            needsReview={sp.needsReview}
            durationS={sp.durationS}
            lineCount={sp.lineCount}
            colorIdx={sp.colorIdx}
            roster={roster}
            isOpen={expanded === sp.localLabel}
            onToggle={() => setExpanded((prev) => (prev === sp.localLabel ? null : sp.localLabel))}
            onChanged={reloadMeeting}
            selectable={sp.needsReview ?? false}
            selected={selected.has(sp.localLabel)}
            onSelect={() => toggleSelected(sp.localLabel)}
          />
        ))}
      </div>
    </div>
  );
}

function SpeakerRow({
  meetingId, localLabel, displayName, rosterId, colorIdx, roster,
  confidence, reviewState, needsReview, durationS, lineCount,
  isOpen, onToggle, onChanged, selectable, selected, onSelect,
}: {
  meetingId: string;
  localLabel: string;
  displayName: string | null;
  rosterId: string | null;
  confidence: number | null;
  reviewState?: 'unknown' | 'probable' | 'confirmed';
  needsReview?: boolean;
  durationS?: number;
  lineCount?: number;
  colorIdx: number;
  roster: RosterEntry[];
  isOpen: boolean;
  onToggle: () => void;
  onChanged: () => void;
  selectable: boolean;
  selected: boolean;
  onSelect: () => void;
}): JSX.Element {
  const named = rosterId !== null;
  const color = colorForSpeakerIndex(colorIdx);
  const layout = speakerReviewLayout();

  return (
    <div
      className={`
        rounded-lg text-xs transition-colors
        ${named ? 'bg-surface-sunken' : 'bg-status-warnBg border border-dashed border-status-warn'}
        ${isOpen ? 'ring-2 ring-brand-indigo/40' : ''}
      `}
    >
      <div className="flex items-center">
        {selectable && (
          <input
            type="checkbox" checked={selected} onChange={onSelect}
            aria-label={`Select ${displayName ?? localLabel} for bulk assignment`}
            className="ml-2 accent-brand-indigo"
          />
        )}
        <button
          onClick={onToggle}
          className={layout.button}
          aria-expanded={isOpen}
        >
        <div
          className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold text-white shrink-0"
          style={{ background: color }}
        >
          {(displayName?.[0] ?? localLabel.replace('SPEAKER_', '').slice(-1) ?? '?').toUpperCase()}
        </div>
        <div className={layout.details}>
          <div className="font-semibold truncate">{displayName ?? localLabel}</div>
          {durationS !== undefined && lineCount !== undefined && <div className="text-[10px] text-ink-muted truncate">
            {named ? `${localLabel} · ` : ''}{fmtSec(durationS)} speaking · {lineCount} line{lineCount === 1 ? '' : 's'}
          </div>}
          {reviewState !== undefined && <div className={layout.status}>
            <span className={`max-w-full text-[10px] px-1.5 py-0.5 rounded-full ${
              reviewState === 'confirmed' ? 'bg-status-okBg text-status-ok'
                : reviewState === 'probable' ? 'bg-brand-indigo/10 text-brand-indigo'
                  : 'bg-status-warnBg text-status-warnText'
            }`}>
              {reviewState === 'confirmed' ? 'Confirmed'
                : reviewState === 'probable' ? `Probably ${displayName ?? ''} ${Math.round((confidence ?? 0) * 100)}%`
                  : 'Unknown'}
            </span>
            {needsReview && <span className="text-[10px] text-status-warnText font-semibold">Needs review</span>}
          </div>}
        </div>
        <svg
          viewBox="0 0 16 16"
          className={`w-3 h-3 text-ink-muted shrink-0 transition-transform ${isOpen ? 'rotate-180' : ''}`}
          fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
        >
          <path d="M3 6l5 5 5-5" />
        </svg>
        </button>
      </div>
      {isOpen && (
        <SpeakerEditor
          meetingId={meetingId}
          localLabel={localLabel}
          rosterId={rosterId}
          roster={roster}
          lineCount={lineCount}
          onChanged={onChanged}
        />
      )}
    </div>
  );
}

function SpeakerEditor({
  meetingId, localLabel, rosterId, roster, lineCount, onChanged,
}: {
  meetingId: string;
  localLabel: string;
  rosterId: string | null;
  roster: RosterEntry[];
  lineCount?: number;
  onChanged: () => void;
}): JSX.Element {
  const [sample, setSample] = useState<{ dataUri: string; startS: number; endS: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<{ id: string; displayName: string; confidence: number }[]>([]);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Lazy-load the sample the first time the row expands; keeps Library scroll
  // snappy when the user is just browsing through 10 speakers without playing.
  useEffect(() => {
    let alive = true;
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const s = await api.speakers.sample(meetingId, localLabel);
        if (!alive) return;
        setSample(s ?? null);
        if (!s) setError('No clip available — speaker has no segments long enough.');
      } catch (e) {
        if (!alive) return;
        setError((e as Error).message);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [meetingId, localLabel]);

  // Ranked "might be X" guesses, fetched alongside the audio sample. Best-
  // effort: if it fails, the panel just falls back to the plain dropdown —
  // this is a convenience, not a required capability.
  useEffect(() => {
    let alive = true;
    api.speakers.suggestions(meetingId, localLabel)
      .then((list) => { if (alive) setSuggestions(list); })
      .catch(() => { /* fall back silently to the manual dropdown */ });
    return () => { alive = false; };
  }, [meetingId, localLabel]);

  async function assignExisting(rid: string): Promise<void> {
    const impact = lineCount === undefined ? 'Transcript lines for this voice will change.'
      : `${lineCount} transcript line${lineCount === 1 ? '' : 's'} will change.`;
    if (rosterId && rid !== rosterId
      && !window.confirm(`Reassign this voice? ${impact}`)) return;
    setBusy(true); setError(null);
    try {
      await api.speakers.assign({ meetingId, localLabel, mode: 'existing', rosterId: rid });
      onChanged();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  async function createNew(): Promise<void> {
    const name = newName.trim();
    if (!name) return;
    setBusy(true); setError(null);
    try {
      await api.speakers.assign({ meetingId, localLabel, mode: 'new', displayName: name });
      setNewName('');
      onChanged();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  async function unlink(): Promise<void> {
    setBusy(true); setError(null);
    try {
      await api.speakers.unlink(meetingId, localLabel);
      onChanged();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  // Narrow the roster dropdown options to not include the currently-linked
  // entry (it'd be a no-op) so the user always sees actionable choices.
  const assignableRoster = roster.filter((r) => r.id !== rosterId);

  return (
    <div className="border-t border-surface-border px-2 py-2 space-y-2">
      {/* Audio player */}
      {loading && (
        <div className="text-[11px] text-ink-muted italic flex items-center gap-1.5">
          <MiniSpinner /> Loading sample…
        </div>
      )}
      {sample && (
        <div className="flex items-center gap-2">
          <button
            onClick={() => audioRef.current?.play()}
            className="shrink-0 w-7 h-7 rounded-full bg-brand-indigo text-white flex items-center justify-center hover:bg-brand-indigo/90 transition"
            aria-label="Play sample"
          >
            <svg viewBox="0 0 16 16" className="w-3 h-3" fill="currentColor">
              <path d="M4 3v10l9-5z" />
            </svg>
          </button>
          <audio ref={audioRef} src={sample.dataUri} preload="auto" controls className="flex-1 h-7" />
        </div>
      )}
      {sample && (
        <div className="text-[10px] text-ink-muted tabular-nums">
          Clip from {fmtSec(sample.startS)} – {fmtSec(sample.endS)} ({(sample.endS - sample.startS).toFixed(1)}s)
        </div>
      )}

      {/* Confidence-ranked guesses computed from the same voice-embedding
          match the auto-linker uses — tap one to confirm instead of typing
          a name from scratch. Excludes whichever entry is already linked. */}
      {suggestions.filter((sug) => sug.id !== rosterId).length > 0 && (
        <div>
          <div className="text-[10px] font-bold text-ink-muted uppercase mb-1">Might be</div>
          <div className="flex flex-wrap gap-1.5">
            {suggestions.filter((sug) => sug.id !== rosterId).map((sug) => (
              <button
                key={sug.id}
                disabled={busy}
                onClick={() => void assignExisting(sug.id)}
                className="text-[11px] font-medium px-2 py-1 rounded-full bg-brand-indigo/10 text-brand-indigo
                           hover:bg-brand-indigo/20 disabled:opacity-40 disabled:cursor-not-allowed transition"
              >
                {sug.displayName} ({Math.round(sug.confidence * 100)}%)
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Assign to existing roster entry */}
      {assignableRoster.length > 0 && (
        <div>
          <div className="text-[10px] font-bold text-ink-muted uppercase mb-1">Assign to</div>
          <select
            disabled={busy}
            value=""
            onChange={(e) => {
              if (e.target.value) void assignExisting(e.target.value);
              e.target.value = '';
            }}
            className="w-full text-xs border border-surface-border rounded-md bg-surface px-2 py-1
                       focus:outline-none focus:border-brand-indigo"
          >
            <option value="">— pick a known speaker —</option>
            {assignableRoster.map((r) => (
              <option key={r.id} value={r.id}>{r.displayName}</option>
            ))}
          </select>
        </div>
      )}

      {/* Create a new roster entry */}
      <div>
        <div className="text-[10px] font-bold text-ink-muted uppercase mb-1">Or add new</div>
        <div className="flex gap-1.5">
          <input
            disabled={busy}
            value={newName}
            placeholder="Full name"
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void createNew(); }}
            className="flex-1 text-xs border border-surface-border rounded-md bg-surface px-2 py-1
                       focus:outline-none focus:border-brand-indigo placeholder:text-ink-muted"
          />
          <button
            disabled={busy || newName.trim().length === 0}
            onClick={createNew}
            className="text-xs font-semibold px-2.5 py-1 rounded-md bg-brand-indigo text-white
                       disabled:opacity-40 disabled:cursor-not-allowed hover:bg-brand-indigo/90 transition"
          >
            Save
          </button>
        </div>
      </div>

      {rosterId !== null && (
        <button
          disabled={busy}
          onClick={unlink}
          className="text-[11px] text-ink-muted hover:text-danger transition underline decoration-dotted"
        >
          Unassign
        </button>
      )}

      {error && <div className="text-[11px] text-danger">{error}</div>}
    </div>
  );
}

function fmtSec(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60).toString().padStart(2, '0');
  return `${m}:${sec}`;
}
