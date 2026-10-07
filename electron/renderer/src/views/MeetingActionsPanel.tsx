import { useEffect, useRef, useState } from 'react';
import { api } from '../ipc/client';
import { Icon } from '../components/icons';
import { shortcutMod } from '../lib/shortcut';
import type { MeetingDetail } from './MeetingDetailView';

export function ActionItemsPanel({
  meeting, onReload, onShowSource,
}: {
  meeting: MeetingDetail;
  onReload: () => Promise<void>;
  onShowSource: (quote: string) => void;
}): JSX.Element {
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [reextracting, setReextracting] = useState(false);
  const [reextractError, setReextractError] = useState<string | null>(null);
  const items = meeting.actionItems;

  // Flip a single item between open ⇄ done. Same reload path add/delete
  // use: the setStatus IPC persists, then onReload() re-fetches the meeting
  // so the row re-renders with the DONE badge / strikethrough.
  async function toggleStatus(it: MeetingDetail['actionItems'][number]): Promise<void> {
    await api.actionItems.setStatus(it.id, it.status === 'done' ? 'open' : 'done');
    await onReload();
  }

  // Re-run ONLY the extract step over the current SAVED summary.md and swap in
  // the fresh items. The meeting's pipeline state is untouched (a 'done'
  // meeting stays 'done'); the whole thing is one short LLM call. onReload()
  // re-fetches the meeting so the regenerated items render.
  async function reextract(): Promise<void> {
    if (reextracting) return;
    setReextracting(true);
    setReextractError(null);
    try {
      await api.actionItems.reextract(meeting.id);
      await onReload();
    } catch (e) {
      setReextractError((e as Error).message);
    } finally {
      setReextracting(false);
    }
  }

  return (
    <div>
      <div className="font-mono text-[11px] tracking-[0.2em] uppercase text-ink-muted font-semibold mb-3 flex items-center gap-2">
        <span>Action items</span>
        <span className="font-normal opacity-70">
          {items.length > 0 ? `· ${items.length}` : ''}
        </span>
      </div>
      {items.length === 0 && !adding && (
        <div className="text-sm text-ink-muted italic mb-3">
          No action items yet. Run Summarize + Extract to get some, or click
          &ldquo;Add item&rdquo; below to write one by hand.
        </div>
      )}
      <div className="space-y-2">
        {items.map((it) => (
          editing === it.id ? (
            <ActionItemEditor
              key={it.id}
              initial={it}
              onCancel={() => setEditing(null)}
              onSaved={async () => { setEditing(null); await onReload(); }}
              onDeleted={async () => { setEditing(null); await onReload(); }}
            />
          ) : (
            <ActionItemDisplay
              key={it.id}
              item={it}
              onOpen={() => setEditing(it.id)}
              onShowSource={onShowSource}
              onToggleStatus={() => void toggleStatus(it)}
            />
          )
        ))}
        {adding && (
          <ActionItemEditor
            key="__new__"
            meetingId={meeting.id}
            onCancel={() => setAdding(false)}
            onSaved={async () => { setAdding(false); await onReload(); }}
          />
        )}
      </div>
      {!adding && (
        <div className="mt-3 flex flex-col gap-2">
          <div className="flex items-center gap-4">
            <button
              onClick={() => setAdding(true)}
              className="text-xs font-semibold text-brand-indigo hover:underline"
            >
              + Add item
            </button>
            <button
              onClick={() => void reextract()}
              disabled={reextracting}
              className="text-xs font-semibold text-brand-indigo hover:underline disabled:opacity-50 disabled:no-underline"
            >
              {reextracting ? 'Re-extracting…' : '↻ Re-extract from summary'}
            </button>
          </div>
          <div className="text-[11px] text-ink-muted">
            Re-extract reads the <span className="font-semibold">saved</span> summary. Edit the
            summary&rsquo;s Action Items section and Save first, then re-extract to pick up your changes.
          </div>
          {reextractError && (
            <div className="text-xs text-danger-text bg-danger-bg border border-danger-border rounded-md px-2.5 py-1.5 whitespace-pre-wrap font-mono">
              {reextractError}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ActionItemDisplay({
  item, onOpen, onShowSource, onToggleStatus,
}: {
  item: MeetingDetail['actionItems'][number];
  onOpen: () => void;
  onShowSource: (quote: string) => void;
  onToggleStatus: () => void;
}): JSX.Element {
  const done = item.status === 'done';
  return (
    <div className="relative flex items-start gap-2">
      {/* Click-to-toggle done circle. A sibling of the open-editor button
          (nested buttons are invalid HTML), so checking an item off never
          accidentally opens the editor. */}
      <button
        type="button"
        onClick={onToggleStatus}
        aria-pressed={done}
        title={done ? 'Mark as open' : 'Mark as done'}
        className={`mt-2.5 w-4 h-4 rounded-full border shrink-0 flex items-center justify-center transition-colors
          ${done
            ? 'bg-status-ok border-status-ok text-white'
            : 'bg-surface border-ink-muted/50 text-transparent hover:border-status-ok hover:text-status-ok/40'}`}
      >
        <svg viewBox="0 0 16 16" className="w-2.5 h-2.5" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 8l3.5 3.5L13 5" />
        </svg>
      </button>
      <button
        onClick={onOpen}
        className="flex-1 min-w-0 text-left rounded-lg border border-surface-border bg-surface
                   hover:border-brand-indigo/60 hover:shadow-pop px-3 py-2 transition"
      >
        <div className={`text-sm ${done ? 'text-ink-muted line-through' : 'text-ink'}`}>{item.text}</div>
        <div className="text-xs text-ink-muted mt-1 flex items-center gap-3">
          {item.ownerName && (
            <span className="inline-flex items-center gap-1">
              <Icon name="user" className="w-3 h-3" />
              {item.ownerName}
            </span>
          )}
          {item.dueDate && (
            <span className="inline-flex items-center gap-1">
              <Icon name="calendar" className="w-3 h-3" />
              {item.dueDate}
            </span>
          )}
          {item.status === 'done' && (
            <span className="bg-status-okBg text-status-ok font-semibold px-1.5 rounded">DONE</span>
          )}
          {item.exportedTo.length > 0 && (
            <span className="text-ink-muted/70">
              exported to {item.exportedTo.join(', ')}
            </span>
          )}
        </div>
      </button>
      {item.sourceQuote && (
        <span
          role="button"
          tabIndex={0}
          onClick={() => onShowSource(item.sourceQuote!)}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onShowSource(item.sourceQuote!); } }}
          title="Show the summary bullet this came from"
          className="absolute top-2 right-2 text-[11px] font-semibold text-brand-indigo/80
                     hover:text-brand-indigo hover:underline cursor-pointer select-none"
        >
          ↦ source
        </span>
      )}
    </div>
  );
}

function ActionItemEditor({
  initial, meetingId, onCancel, onSaved, onDeleted,
}: {
  /** When editing an existing item, `initial` carries the current values.
   *  When creating a new one, `meetingId` is set and `initial` is absent. */
  initial?: MeetingDetail['actionItems'][number];
  meetingId?: string;
  onCancel: () => void;
  onSaved: () => Promise<void>;
  onDeleted?: () => Promise<void>;
}): JSX.Element {
  const [text, setText] = useState(initial?.text ?? '');
  const [owner, setOwner] = useState(initial?.ownerName ?? '');
  const [due, setDue] = useState(initial?.dueDate ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => { textareaRef.current?.focus(); }, []);

  async function save(): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) { setErr('Text cannot be empty.'); return; }
    setBusy(true); setErr(null);
    try {
      if (initial) {
        await api.actionItems.update(initial.id, {
          text: trimmed,
          ownerName: owner.trim() || null,
          dueDate: due || null,
        });
      } else if (meetingId) {
        await api.actionItems.create(meetingId, {
          text: trimmed,
          ownerName: owner.trim() || null,
          dueDate: due || null,
        });
      }
      await onSaved();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }

  async function deleteItem(): Promise<void> {
    if (!initial) return;
    setBusy(true); setErr(null);
    try {
      await api.actionItems.delete(initial.id);
      await onDeleted?.();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-brand-indigo/40 bg-brand-indigo/5 p-3 space-y-2">
      <textarea
        ref={textareaRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void save(); }
          if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
        }}
        placeholder="What needs to happen?"
        rows={2}
        className="w-full text-sm p-2 border border-surface-border rounded-md bg-surface
                   focus:outline-none focus:border-brand-indigo focus:shadow-[0_0_0_3px_rgba(99,102,241,0.15)]
                   resize-y min-h-[44px]"
      />
      <div className="flex gap-2">
        <input
          value={owner}
          onChange={(e) => setOwner(e.target.value)}
          placeholder="Owner (optional)"
          maxLength={200}
          className="flex-1 text-sm p-2 border border-surface-border rounded-md bg-surface
                     focus:outline-none focus:border-brand-indigo"
        />
        <input
          type="date"
          value={due}
          onChange={(e) => setDue(e.target.value)}
          className="text-sm p-2 border border-surface-border rounded-md bg-surface
                     focus:outline-none focus:border-brand-indigo"
        />
      </div>
      {err && <div className="text-xs text-danger">{err}</div>}
      <div className="flex items-center gap-2">
        {initial && onDeleted && (
          <button
            onClick={() => void deleteItem()}
            disabled={busy}
            className="text-xs font-semibold text-danger hover:text-danger-text px-2 py-1
                       rounded hover:bg-danger-bg disabled:opacity-50"
          >
            Delete
          </button>
        )}
        <span className="text-[11px] text-ink-muted">
          <kbd className="font-mono">{shortcutMod()}+Enter</kbd> to save · <kbd className="font-mono">Esc</kbd> to cancel
        </span>
        <div className="flex-1" />
        <button
          onClick={onCancel}
          disabled={busy}
          className="text-xs text-ink-muted hover:text-ink px-3 py-1.5 rounded-lg"
        >
          Cancel
        </button>
        <button
          onClick={() => void save()}
          disabled={busy}
          className="text-xs font-semibold text-white bg-brand-indigo hover:bg-brand-indigo/90
                     px-3 py-1.5 rounded-lg disabled:opacity-50"
        >
          {busy ? 'Saving…' : initial ? 'Save' : 'Add'}
        </button>
      </div>
    </div>
  );
}

export function Placeholder({ text }: { text: string }): JSX.Element {
  return <div className="text-sm text-ink-muted italic">{text}</div>;
}
