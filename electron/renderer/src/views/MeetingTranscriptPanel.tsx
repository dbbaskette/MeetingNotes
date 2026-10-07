import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../ipc/client';
import { useToast } from '../components/Toasts';
import { colorForSpeakerIndex } from '../theme/tokens';
import { speakerColorIndex } from '../lib/speaker-colors';
import { parseTranscript, fmtTimestamp, groupConsecutiveBySpeaker, formatTranscriptForExport, activeLineIndexAt, type TranscriptLine, type TranscriptGroup, type ExportFormat } from '../lib/transcript-lines';
import type { MeetingDetail } from './MeetingDetailView';

type TranscriptViewMode = 'lines' | 'grouped';
const VIEW_MODE_KEY = 'mn:transcript-view-mode';

function readStoredViewMode(): TranscriptViewMode {
  if (typeof localStorage === 'undefined') return 'lines';
  const v = localStorage.getItem(VIEW_MODE_KEY);
  return v === 'grouped' ? 'grouped' : 'lines';
}

export function TranscriptPanel({
  meeting, showRaw, currentTime, onSeek,
}: {
  meeting: MeetingDetail;
  showRaw: boolean;
  currentTime: number;
  onSeek: (seconds: number) => void;
}): JSX.Element {
  const body = meeting.transcriptMd ?? meeting.rawTranscriptText ?? '';
  const parsed = useMemo(() => parseTranscript(body), [body]);
  const groups = useMemo(
    () => groupConsecutiveBySpeaker(parsed.lines),
    [parsed.lines],
  );
  const [viewMode, setViewMode] = useState<TranscriptViewMode>(readStoredViewMode);
  useEffect(() => {
    try { localStorage.setItem(VIEW_MODE_KEY, viewMode); } catch { /* private mode */ }
  }, [viewMode]);

  // Speaker → palette index by first appearance (#A4), sharing the avatar
  // palette so the tinted name matches the speaker's rail color language.
  // Memoized on the parsed lines; each row receives the resolved color as
  // a PRIMITIVE string prop so React.memo on the rows keeps bailing.
  const colorIdxBySpeaker = useMemo(() => speakerColorIndex(parsed.lines), [parsed.lines]);
  const speakerColor = (speaker: string): string =>
    colorForSpeakerIndex(colorIdxBySpeaker.get(speaker) ?? 0);

  // Active line = the one whose [start, nextStart) window covers currentTime.
  // Computed ONCE per render here so each row receives a stable primitive
  // `active` boolean — React.memo on the rows then bails everything except
  // the (at most) two rows whose `active` flipped on this tick.
  const activeIdx = useMemo(
    () => activeLineIndexAt(parsed.lines, currentTime),
    [parsed.lines, currentTime],
  );

  // Active group = the group whose lineIndices range contains activeIdx.
  // Stored as a number for the same scrollIntoView trigger; -1 means none.
  const activeGroupIdx = useMemo(() => {
    if (activeIdx < 0) return -1;
    return groups.findIndex(
      (g) => activeIdx >= g.lineIndices[0]! && activeIdx <= g.lineIndices[g.lineIndices.length - 1]!,
    );
  }, [groups, activeIdx]);

  // Auto-scroll the active line into view — but only when the user hasn't
  // scrolled manually in the last few seconds (don't fight them). A
  // "lastUserScrollAt" timestamp bumps on any wheel/touch event inside the
  // scroll container.
  const panelRef = useRef<HTMLDivElement | null>(null);
  const activeRef = useRef<HTMLButtonElement | null>(null);
  const lastManualScrollAt = useRef(0);
  useEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const onScroll = (): void => { lastManualScrollAt.current = Date.now(); };
    el.addEventListener('wheel', onScroll, { passive: true });
    el.addEventListener('touchmove', onScroll, { passive: true });
    return () => {
      el.removeEventListener('wheel', onScroll);
      el.removeEventListener('touchmove', onScroll);
    };
  }, []);
  useEffect(() => {
    if (Date.now() - lastManualScrollAt.current < 3000) return;
    activeRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [activeIdx, activeGroupIdx, viewMode]);

  if (body === '') {
    return (
      <div className="text-sm text-ink-muted italic">
        No transcript yet. Waiting for the transcribe stage to finish.
      </div>
    );
  }
  if (parsed.hasUnparsed || parsed.lines.length === 0) {
    // Raw / partial transcript — just render as prose.
    return (
      <>
        {showRaw && (
          <div className="mb-3 text-xs text-status-warnText bg-status-warnBg border border-status-warn/40 rounded-lg px-3 py-2">
            Early preview — raw whisper output. Speaker labels and timestamps
            will be filled in once diarization + merge finish.
          </div>
        )}
        <div className="text-sm leading-relaxed whitespace-pre-wrap font-sans">
          {body}
        </div>
      </>
    );
  }

  return (
    <div className="space-y-2">
      {/* View toggle + export. Right-aligned so they sit in the
          existing tab-row's empty space without forcing the transcript
          text down. The view toggle's two buttons share a pill so the
          active state is unambiguous; export is a separate group with
          a menu for the format choice. */}
      <div className="flex items-center justify-end gap-2 -mt-2 mb-1">
        <div className="inline-flex items-center text-[11px] font-semibold rounded-full border border-surface-border bg-surface overflow-hidden">
          <ViewToggleButton
            active={viewMode === 'lines'}
            onClick={() => setViewMode('lines')}
            label="Per line"
            title="Show every timestamped line as its own row"
          />
          <ViewToggleButton
            active={viewMode === 'grouped'}
            onClick={() => setViewMode('grouped')}
            label="Grouped"
            title="Collapse consecutive same-speaker lines into one paragraph"
          />
        </div>
        <ExportTranscriptButton
          lines={parsed.lines}
          viewMode={viewMode}
          meeting={meeting}
        />
      </div>

      {/* Scrolling is delegated to the parent rail now that the detail
          view caps its own height — a nested scroll container here would
          give the user two scrollbars to fight. The wheel/touchmove
          listeners below still fire on this element regardless of who
          actually scrolls, so "don't fight manual scroll" keeps working. */}
      <div ref={panelRef} className="text-sm leading-relaxed font-sans pr-1">
        {viewMode === 'lines' ? (
          parsed.lines.map((line, i) => (
            <TranscriptLineRow
              key={i}
              line={line}
              active={i === activeIdx}
              speakerColor={speakerColor(line.speaker)}
              onSeek={onSeek}
              activeRef={activeRef}
            />
          ))
        ) : (
          groups.map((g, i) => (
            <TranscriptGroupRow
              key={i}
              group={g}
              active={i === activeGroupIdx}
              speakerColor={speakerColor(g.speaker)}
              onSeek={onSeek}
              activeRef={activeRef}
            />
          ))
        )}
      </div>
    </div>
  );
}

function ViewToggleButton({
  active, onClick, label, title,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  title: string;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`px-2.5 py-1 transition-colors ${
        active ? 'bg-ink text-surface' : 'text-ink-muted hover:text-ink hover:bg-surface-sunken'
      }`}
    >
      {label}
    </button>
  );
}

/** Export-as menu next to the view toggle. Click → small popover with
 *  "Markdown (.md)" / "Plain text (.txt)" choices. The chosen format
 *  uses formatTranscriptForExport() with the active view mode, then
 *  hands the string off to the transcript:export IPC which shows the
 *  native save dialog and writes the file. */
function ExportTranscriptButton({
  lines, viewMode, meeting,
}: {
  lines: readonly TranscriptLine[];
  viewMode: 'lines' | 'grouped';
  meeting: { title: string; startedAt: string | null };
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const toast = useToast();

  // Click-outside to dismiss. Mounted only while the menu is open.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent): void => {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open]);

  // Slug-from-title helper — for the default save filename. Falls back
  // to the literal "transcript" when the title is empty/all-symbols.
  function defaultName(format: ExportFormat): string {
    const slug = (meeting.title || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'transcript';
    const suffix = viewMode === 'grouped' ? '-grouped' : '';
    return `${slug}${suffix}.transcript.${format}`;
    // Note: `.transcript.<ext>` keeps the filename distinct from the
    // summary export the user might do later.
  }

  async function exportAs(format: ExportFormat): Promise<void> {
    if (busy) return;
    setOpen(false);
    setBusy(true);
    try {
      const content = formatTranscriptForExport(lines, {
        title: meeting.title,
        startedAt: meeting.startedAt,
        viewMode,
        format,
      });
      const result = await api.meetings.exportTranscript({
        content,
        defaultName: defaultName(format).replace(/\.(md|txt)$/, ''),
        format,
      });
      if (result.path) {
        toast.show({ message: `Exported to ${result.path}`, durationMs: 4000 });
      } else {
        // Cancelled — fall back to clipboard so the keystrokes
        // weren't wasted. Same pattern the WeeklyView export uses.
        await navigator.clipboard.writeText(content);
        toast.show({
          message: `Save cancelled — transcript copied to clipboard instead`,
          durationMs: 3500,
        });
      }
    } catch (e) {
      toast.show({
        message: `Export failed: ${(e as Error).message}`,
        durationMs: 5000,
      });
    } finally {
      setBusy(false);
    }
  }

  const disabled = busy || lines.length === 0;

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        title="Export transcript"
        aria-haspopup="menu"
        aria-expanded={open}
        className="inline-flex items-center gap-1 text-[11px] font-semibold rounded-full border border-surface-border bg-surface px-2.5 py-1
                   text-ink-muted hover:text-ink hover:border-ink/30
                   disabled:opacity-50 disabled:cursor-not-allowed transition"
      >
        <svg viewBox="0 0 24 24" className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2}>
          <path d="M12 3v12m0 0l-4-4m4 4l4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
        </svg>
        <span>Export</span>
        <svg viewBox="0 0 24 24" className="w-2.5 h-2.5 opacity-70" fill="none" stroke="currentColor" strokeWidth={2.5}>
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full mt-1 z-30 min-w-[200px] bg-surface rounded-lg border border-surface-border shadow-pop overflow-hidden text-sm"
        >
          <ExportMenuItem
            label="Markdown (.md)"
            sublabel="Bold names, blockquoted text"
            onClick={() => void exportAs('md')}
          />
          <ExportMenuItem
            label="Plain text (.txt)"
            sublabel="No formatting, sharable anywhere"
            onClick={() => void exportAs('txt')}
          />
        </div>
      )}
    </div>
  );
}

function ExportMenuItem({
  label, sublabel, onClick,
}: {
  label: string;
  sublabel: string;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      role="menuitem"
      type="button"
      onClick={onClick}
      className="w-full text-left px-3 py-2 hover:bg-surface-sunken transition"
    >
      <div className="font-medium text-ink">{label}</div>
      <div className="text-[11px] text-ink-muted">{sublabel}</div>
    </button>
  );
}

// Transcript rows are memoized: during playback the panel re-renders once
// per second (quantized currentTime), and without memo every one of the
// potentially thousands of rows would be reconciled per tick. Each row
// receives only stable-identity props (line/group objects from a useMemo'd
// parse, the useCallback'd onSeek, the ref object itself) plus a primitive
// `active` boolean — so memo bails on all rows except the two whose
// `active` flag flipped.
const TranscriptLineRow = memo(function TranscriptLineRow({
  line, active, speakerColor, onSeek, activeRef,
}: {
  line: TranscriptLine;
  active: boolean;
  /** Palette color for this line's speaker (#A4). A primitive string
   *  computed from the parent's memoized first-appearance map, so it's
   *  value-stable across playback ticks and memo keeps bailing. */
  speakerColor: string;
  onSeek: (seconds: number) => void;
  /** Attached only while `active` — drives the auto-scroll-into-view. */
  activeRef: React.RefObject<HTMLButtonElement>;
}): JSX.Element {
  return (
    <button
      ref={active ? activeRef : undefined}
      onClick={() => onSeek(line.seconds)}
      title={`Jump to ${fmtTimestamp(line.seconds)}`}
      className={`w-full text-left rounded-md px-2 py-1 mb-0.5 transition-colors
        ${active
          ? 'bg-brand-indigo/10 ring-1 ring-brand-indigo/30'
          : 'hover:bg-surface-sunken'}`}
    >
      <span className="font-mono text-[11px] text-ink-muted tabular-nums mr-2">
        {fmtTimestamp(line.seconds)}
      </span>
      <span className="font-semibold mr-2" style={{ color: speakerColor }}>{line.speaker}</span>
      <span>{line.text}</span>
    </button>
  );
});

/** Grouped-view row: speaker name on its own line above the merged
 *  paragraph, with the start–end range to its right. Cleaner than
 *  inlining everything when the merged text is long. */
const TranscriptGroupRow = memo(function TranscriptGroupRow({
  group, active, speakerColor, onSeek, activeRef,
}: {
  group: TranscriptGroup;
  active: boolean;
  /** Primitive palette color for the group's speaker — see TranscriptLineRow. */
  speakerColor: string;
  onSeek: (seconds: number) => void;
  activeRef: React.RefObject<HTMLButtonElement>;
}): JSX.Element {
  const showRange = group.endSeconds > group.startSeconds;
  return (
    <button
      ref={active ? activeRef : undefined}
      onClick={() => onSeek(group.startSeconds)}
      title={`Jump to ${fmtTimestamp(group.startSeconds)}`}
      className={`w-full text-left rounded-md px-3 py-2 mb-2 transition-colors
        ${active
          ? 'bg-brand-indigo/10 ring-1 ring-brand-indigo/30'
          : 'hover:bg-surface-sunken'}`}
    >
      <div className="flex items-baseline gap-2 mb-1">
        <span className="font-semibold" style={{ color: speakerColor }}>{group.speaker}</span>
        <span className="font-mono text-[11px] text-ink-muted tabular-nums">
          {fmtTimestamp(group.startSeconds)}
          {showRange && (
            <>
              {' '}
              <span className="opacity-60">–</span>
              {' '}
              {fmtTimestamp(group.endSeconds)}
            </>
          )}
        </span>
      </div>
      <div className="text-ink-soft">{group.text}</div>
    </button>
  );
});
