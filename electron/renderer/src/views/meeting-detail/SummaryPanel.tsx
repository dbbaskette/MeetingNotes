// electron/renderer/src/views/meeting-detail/SummaryPanel.tsx
// Notes (summary) panel with its toolbar, preview and editor, moved out of
// MeetingDetailView.tsx (#256).
import { useDeferredValue, useEffect, useId, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api } from '../../ipc/client';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Icon, IconLabel } from '../../components/icons';
import { RememberTerms, TerminologyPanel } from '../../components/Terminology';
import { correctionCandidates, type TermCandidate } from '../../../../shared/terminology-matcher';
import { NotesHistory } from '../../components/NotesHistory';
import { SegmentedControl } from '../../components/SegmentedControl';
import { useToast } from '../../components/Toasts';
import { shortcutMod } from '../../lib/shortcut';
import { Placeholder } from '../MeetingActionsPanel';
import { useContentVersion } from './hooks/useContentVersion';
import type { MeetingDetail, SummaryMode } from './types';

// ─── Summary panel ─────────────────────────────────────────────────────────
//
// Two modes for the LLM-generated summary:
//   view — rendered markdown only
//   edit — textarea + live preview side-by-side
// The previous third mode (full-width textarea, no preview) overlapped with
// edit's editor pane and added decision-fatigue without unique value.
// Anyone wanting more horizontal room can resize the window.
//
// The user owns the final text — the summarize stage gives a starting draft,
// but cleanup is almost always needed (model hallucinations, formatting
// tweaks, redactions). Saved markdown is written straight to summary.md on
// disk; the next pipeline run that touches summarize will overwrite, so
// users wanting to preserve edits across re-runs should avoid re-summarizing.
//
// Edits are kept in LIFTED state (the view root owns draft/mode/baseline —
// this panel unmounts on every tab switch, so keeping the session here
// used to silently discard edits) and only persisted on Save. Disk writes
// happen via the meetings:save-summary IPC, NOT via re-running the pipeline.

export function SummaryPanel({
  meeting, onReload, provenance, mode, onMode, draft, onDraft, savedValue, onBaseline,
}: {
  meeting: MeetingDetail;
  onReload: () => Promise<void>;
  provenance: { quote: string; nonce: number } | null;
  mode: SummaryMode;
  onMode: (m: SummaryMode) => void;
  draft: string;
  onDraft: (v: string) => void;
  /** The local "what's on disk" baseline. Advances via onBaseline on a
   *  successful save, ahead of `meeting.summaryMd` catching up to the
   *  reload — so dirty (and the view) reflect the just-saved content. */
  savedValue: string;
  onBaseline: (v: string) => void;
}): JSX.Element {
  const original = meeting.summaryMd ?? '';
  const toast = useToast();
  // Transient save-cycle state can stay local: losing "Saving…" / the
  // ✓-saved timestamp / an error banner on a tab switch is harmless.
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [termCandidates, setTermCandidates] = useState<TermCandidate[]>([]);
  const dismissedTerms = useRef(new Set<string>());
  const saveGeneration = useRef(0);
  useEffect(() => () => { saveGeneration.current++; }, []);
  // Why the regenerate dialog is open: corrected transcript or new names.
  const [confirmRegenerate, setConfirmRegenerate] = useState<'terms' | 'names' | null>(null);

  const dirty = draft !== savedValue;
  // Edit mode: the textarea updates at once, the parsed preview follows when
  // React has a free frame, so typing in a long summary doesn't wait on a
  // full markdown re-parse per keystroke (#301).
  const previewDraft = useDeferredValue(draft);
  const contentVersion = useContentVersion(meeting.transcriptMd, meeting.summaryMd);

  async function save(): Promise<void> {
    if (!dirty || saving) return;
    const before = savedValue, submitted = draft, generation = ++saveGeneration.current;
    setSaving(true); setError(null);
    try {
      await api.meetings.saveSummary(meeting.id, submitted);
      if (generation !== saveGeneration.current) return;
      onBaseline(submitted);
      setSavedAt(new Date());
      // After a successful save, drop back into view so the rendered
      // markdown reflects what's now on disk.
      onMode('view');
      // Refresh the parent so other panes keying off `meeting.summaryMd`
      // (e.g. RightRail's "has summary" check) see the new content.
      void onReload();
      // Learning is independent of the save. A dictionary failure must never
      // misreport a successful notes save as failed.
      void Promise.all([api.terminology.offers(), api.terminology.list()]).then(([enabled, rules]) => {
        if (!enabled || generation !== saveGeneration.current) return;
        setTermCandidates(correctionCandidates(before, submitted).filter(c =>
          !dismissedTerms.current.has(`${c.source}\0${c.replacement}`)
          && !rules.some(r => r.source.toLowerCase() === c.source.toLowerCase() && (r.groupId === null || r.groupId === meeting.groupId))));
      }).catch(() => { /* Learning can be retried from Settings; notes are saved. */ });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  if (!original && !dirty) {
    return <><NotesHistory meetingId={meeting.id} disabled={meeting.status === 'processing'} onRestored={async summary => {onBaseline(summary); onDraft(summary); await onReload();}}/><Placeholder text="Summary will appear after the summarize stage." /></>;
  }

  return (
    <div className="flex flex-col gap-3">
      <NotesHistory meetingId={meeting.id} disabled={dirty || saving || mode === 'edit' || meeting.status === 'processing'} onRestored={async summary => {onBaseline(summary); onDraft(summary); await onReload();}}/>
      {meeting.summaryStale && <details className="text-xs text-ink-muted">
        <summary className="cursor-pointer">Notes may need refreshing</summary>
        The transcript was corrected after these notes were generated. Regenerating replaces the notes and action items.
        <button className="ml-2 underline font-semibold disabled:opacity-40" disabled={dirty || meeting.status === 'processing'} onClick={() => setConfirmRegenerate('terms')}>Regenerate notes…</button>
      </details>}
      {meeting.namesChangedSinceNotes && meeting.status === 'done' && <p className="text-xs text-ink-muted">
        Names changed. Regenerate notes to rewrite them with the new names?
        <button className="ml-2 underline font-semibold disabled:opacity-40" disabled={dirty} onClick={() => setConfirmRegenerate('names')}>Regenerate notes…</button>
      </p>}
      <ConfirmDialog open={confirmRegenerate !== null} title={confirmRegenerate === 'names' ? 'Regenerate notes with the new names?' : 'Regenerate notes from the corrected transcript?'} body="The current notes and action items will be saved in history before being replaced. The transcript and remembered terminology are preserved." confirmLabel="Regenerate notes" onCancel={() => setConfirmRegenerate(null)} onConfirm={() => {
        setConfirmRegenerate(null);
        void api.meetings.rerun(meeting.id, 'summarizing').then(onReload).catch(e => setError((e as Error).message));
      }}/>
      {termCandidates.length > 0 && <RememberTerms key={termCandidates.map(c => c.source+c.replacement).join('|')} candidates={termCandidates}
        groupId={meeting.groupId} groupName={meeting.groupName} onClose={() => {for (const c of termCandidates) dismissedTerms.current.add(`${c.source}\0${c.replacement}`); setTermCandidates([]);}}/>}
      <TerminologyPanel key={`summary-terms-${meeting.id}`} meetingId={meeting.id} artifact="meeting" version={contentVersion}
        groupId={meeting.groupId} groupName={meeting.groupName} disabled={dirty || mode === 'edit' || meeting.status === 'processing'} onReload={onReload}/>
      <SummaryToolbar
        mode={mode}
        onMode={onMode}
        dirty={dirty}
        saving={saving}
        savedAt={savedAt}
        error={error}
        onSave={save}
        onRevert={() => { onDraft(savedValue); setError(null); }}
        onCopy={() => {
          void navigator.clipboard.writeText(draft)
            .then(() => toast.show({ message: 'Notes copied as Markdown', durationMs: 3000 }))
            .catch((cause: unknown) => toast.show({ message: `Could not copy notes: ${(cause as Error).message}`, variant: 'error' }));
        }}
      />
      {mode === 'view' && <MarkdownPreview source={draft} highlight={provenance} />}
      {mode === 'edit' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <MarkdownEditor value={draft} onChange={onDraft} onSave={() => { if (dirty && !saving) void save(); }} />
          <div className="border border-surface-border rounded-lg p-4 bg-surface-sunken/40 overflow-auto max-h-[60vh]">
            <MarkdownPreview source={previewDraft} />
          </div>
        </div>
      )}
    </div>
  );
}

function SummaryToolbar({
  mode, onMode, dirty, saving, savedAt, error, onSave, onRevert, onCopy,
}: {
  mode: SummaryMode;
  onMode: (m: SummaryMode) => void;
  /** Copy the notes, as they are on screen, to the clipboard as Markdown. */
  onCopy: () => void;
  dirty: boolean;
  saving: boolean;
  savedAt: Date | null;
  error: string | null;
  onSave: () => Promise<void> | void;
  onRevert: () => void;
}): JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <SegmentedControl label="Notes mode" value={mode} onChange={onMode}
        options={[{ value: 'view', label: 'View' }, { value: 'edit', label: 'Edit' }]} />
      <div className="flex-1 min-w-0">
        {error && <span className="text-xs text-danger truncate" title={error}>{error}</span>}
        {!error && dirty && <span className="text-xs text-ink-muted">Unsaved changes</span>}
        {!error && !dirty && savedAt && (
          <span className="text-xs text-status-ok">
            <Icon name="check" className="inline w-3.5 h-3.5 mr-1 align-[-2px]" />Saved {savedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </span>
        )}
      </div>
      {dirty && (
        <button
          onClick={onRevert}
          className="text-xs text-ink-muted hover:text-ink px-2 py-1 rounded hover:bg-surface-sunken"
        >
          Revert
        </button>
      )}
      <button type="button" onClick={onCopy} className="btn-secondary" title="Copy the notes as Markdown">
        <IconLabel icon="copy">Copy Markdown</IconLabel>
      </button>
      <button
        type="button"
        onClick={() => void onSave()}
        disabled={!dirty || saving}
        title={`Save (${shortcutMod()}S)`}
        className="text-xs font-semibold bg-brand-solid text-white px-3 py-1 rounded-md
                   hover:bg-brand-solid/90 disabled:opacity-40 disabled:cursor-not-allowed transition"
      >
        {saving ? 'Saving…' : 'Save'}
      </button>
    </div>
  );
}

function MarkdownPreview({
  source, highlight,
}: {
  source: string;
  highlight?: { quote: string; nonce: number } | null;
}): JSX.Element {
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Normalize the way we compare item-source text to rendered markdown text:
  // markdown may render "—" / smart quotes differently than the on-disk
  // bullet, and whitespace collapses. Lowercase + strip non-alphanumerics so
  // "Ship the v2 API — Dan" matches the rendered "Ship the v2 API — Dan".
  const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

  useEffect(() => {
    const root = rootRef.current;
    if (!root || !highlight?.quote) return;
    const target = norm(highlight.quote);
    if (!target) return;
    // Search list items first (action items are bullets), then paragraphs.
    const nodes = Array.from(root.querySelectorAll('li, p')) as HTMLElement[];
    const hit = nodes.find((n) => norm(n.textContent ?? '').includes(target));
    if (!hit) return;
    hit.classList.add('provenance-flash');
    hit.scrollIntoView({ block: 'center', behavior: 'smooth' });
    const t = setTimeout(() => hit.classList.remove('provenance-flash'), 2600);
    return () => clearTimeout(t);
    // `nonce` in the dep list re-runs this when the same item is clicked twice.
  }, [highlight?.quote, highlight?.nonce]);

  // Parsing markdown is the expensive part (a long summary/transcript runs
  // tens of ms). Memoize the element on `source` so re-renders that don't
  // change the text — provenance-highlight clicks, the 2s meeting poll while
  // processing, any parent state churn — reuse the previous element and React
  // bails out of the subtree instead of re-parsing.
  const rendered = useMemo(
    () => <ReactMarkdown remarkPlugins={[remarkGfm]}>{source}</ReactMarkdown>,
    [source],
  );

  // `prose` gives us reasonable defaults for headings, lists, code blocks,
  // tables (via remark-gfm), and links — without us having to hand-style
  // every element. `whitespace-pre-wrap` is intentionally absent: the
  // markdown renderer handles its own line breaks via paragraph splitting.
  return (
    <div ref={rootRef} className="prose prose-sm max-w-none prose-headings:mt-3 prose-p:my-2">
      {rendered}
    </div>
  );
}

function MarkdownEditor({
  value, onChange, onSave,
}: { value: string; onChange: (v: string) => void; onSave?: () => void }): JSX.Element {
  // Simple textarea — no codemirror / monaco. Keeps the bundle slim and the
  // editing experience predictable. Tab key inserts two spaces (otherwise
  // it'd shift focus away, which is awful in a long edit).
  //
  // That must not trap keyboard users (WCAG 2.1.2): Shift+Tab always moves
  // focus back, and Escape releases the next Tab so it moves focus forward.
  const ref = useRef<HTMLTextAreaElement>(null);
  const tabReleased = useRef(false);
  const hintId = useId();
  // Track line count so we can grow the textarea proportionally without
  // clipping; capped at 60vh so the toolbar stays visible.
  const lineCount = useMemo(() => Math.max(8, value.split('\n').length + 2), [value]);
  return (
    <div className="min-w-0">
    <textarea
      ref={ref}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={() => { tabReleased.current = false; }}
      onKeyDown={(e) => {
        // Cmd/Ctrl+S saves without leaving the editor (#298).
        if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 's') { e.preventDefault(); onSave?.(); return; }
        if (e.key === 'Escape') { tabReleased.current = true; return; }
        if (e.key === 'Tab') {
          if (e.shiftKey || tabReleased.current) return; // let focus leave
          e.preventDefault();
          const ta = e.currentTarget;
          const { selectionStart: ss, selectionEnd: se, value: v } = ta;
          const next = `${v.slice(0, ss)}  ${v.slice(se)}`;
          onChange(next);
          // Restore caret after React rerenders.
          requestAnimationFrame(() => {
            ta.selectionStart = ta.selectionEnd = ss + 2;
          });
        } else if (e.key.length === 1 || e.key === 'Enter' || e.key === 'Backspace') {
          tabReleased.current = false; // typing again: Tab indents once more
        }
      }}
      aria-label="Notes (Markdown)"
      aria-describedby={hintId}
      spellCheck
      className="w-full font-mono text-[13px] leading-relaxed text-ink bg-surface-sunken/40
                 border border-surface-border rounded-lg p-3 resize-none
                 focus:outline-none focus:ring-2 focus:ring-brand-indigo/40 focus:border-brand-indigo
                 max-h-[60vh] overflow-auto"
      style={{ minHeight: `${Math.min(lineCount, 30) * 1.5}rem` }}
    />
    <p id={hintId} className="mt-1 text-[11px] text-ink-muted">Tab indents. Press Esc then Tab to leave the editor; Shift+Tab goes back. {shortcutMod()}S saves.</p>
    </div>
  );
}
