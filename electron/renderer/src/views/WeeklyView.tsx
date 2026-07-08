// electron/renderer/src/views/WeeklyView.tsx
//
// Real wired-up weekly view. Fetches structured data from the main
// process via api.weekly.get(year, week), renders the narrative +
// meetings + grouped action items + decisions, and lets the user
// regenerate the LLM narrative or export the whole thing as Markdown.
//
// All data shapes mirror the WeeklyData interface in
// electron/main/weekly/aggregator.ts. We intentionally don't import
// it from there (main vs renderer module boundary) — the IPC payload
// is the contract and the types are mirrored locally.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../ipc/client';
import { useToast } from '../components/Toasts';
import { fmtDueLabel } from '../lib/due-date';
import { weekToInputValue, parseWeekInput, compareIsoWeeks } from '../lib/week-input';
import logoUrl from '../assets/logo.png';

interface Props {
  /** Open the meeting detail view for the given id when a meeting
   *  row in the list is clicked. */
  onOpenMeeting: (id: string) => void;
  onBack: () => void;
}

// Mirrors of the IPC types — kept in sync with
// electron/main/weekly/aggregator.ts. We don't import from main
// across the renderer/main module boundary; the IPC payload is
// the contract.
interface WeeklyMeeting {
  id: string;
  title: string;
  startedAt: string;
  durationS: number | null;
  highlight: string | null;
  speakerCount: number | null;
}
interface WeeklyActionItem {
  id: string;
  meetingId: string;
  meetingTitle: string;
  text: string;
  ownerLabel: string | null;
  isYou: boolean;
  status: string;
  dueDate: string | null;
  meetingStartedAt: string;
}
interface WeeklyOwnerGroup {
  ownerLabel: string;
  isYou: boolean;
  items: WeeklyActionItem[];
}

/** Fast-path data that paints the page immediately. */
interface WeeklyStructured {
  isoYear: number;
  isoWeek: number;
  rangeStart: string;
  rangeEnd: string;
  totalDurationS: number;
  meetings: WeeklyMeeting[];
  openActionGroups: WeeklyOwnerGroup[];
  openActionCount: number;
  inProgress: boolean;
  /** True when the cached narrative will return instantly — used to
   *  decide whether to show the "drafting" skeleton vs render
   *  immediately. */
  hasFreshCache: boolean;
}

interface WeeklyTheme {
  title: string;
  detail: string;
  meetings: string[];
}

/** Slow-path payload from the LLM. */
interface WeeklyNarrativeResult {
  narrative: string;
  themes: WeeklyTheme[];
  decisions: string[];
  generatedAt: string;
  fromCache: boolean;
}

// Local copy of getIsoWeek — small enough that a renderer-side
// dependency is cheaper than another IPC round-trip just to know
// "what week are we in right now".
function currentIsoWeek(now = new Date()): { year: number; week: number } {
  const target = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dow = (target.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dow + 3);
  const isoYear = target.getUTCFullYear();
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const jan4Dow = (jan4.getUTCDay() + 6) % 7;
  const week1Thursday = new Date(jan4);
  week1Thursday.setUTCDate(jan4.getUTCDate() - jan4Dow + 3);
  const diffMs = target.getTime() - week1Thursday.getTime();
  return { year: isoYear, week: 1 + Math.round(diffMs / (7 * 24 * 60 * 60 * 1000)) };
}

function shiftWeek(input: { year: number; week: number }, delta: number): { year: number; week: number } {
  // Convert week number → Monday of that week → add delta*7 days → convert back.
  const jan4 = new Date(Date.UTC(input.year, 0, 4));
  const jan4Dow = (jan4.getUTCDay() + 6) % 7;
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - jan4Dow);
  const target = new Date(week1Monday);
  target.setUTCDate(week1Monday.getUTCDate() + (input.week - 1) * 7 + delta * 7);
  return currentIsoWeek(target);
}

function fmtDay(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { weekday: 'short' });
}

function fmtTimeShort(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function fmtMeetingDuration(seconds: number | null): string {
  if (seconds == null) return '—';
  const m = Math.round(seconds / 60);
  return `${m}m`;
}

function fmtTotalDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function fmtRange(rangeStart: string, rangeEnd: string, year: number): string {
  const fmt = (iso: string): string => new Date(iso).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', timeZone: 'UTC',
  });
  return `Week of ${fmt(rangeStart)} – ${fmt(rangeEnd)}, ${year}`;
}

export function WeeklyView({ onOpenMeeting, onBack }: Props): JSX.Element {
  const [week, setWeek] = useState(() => currentIsoWeek());
  const [structured, setStructured] = useState<WeeklyStructured | null>(null);
  const [narrative, setNarrative] = useState<WeeklyNarrativeResult | null>(null);
  /** Loading states are independent: structured paints in tens of
   *  ms; narrative may take 30+s on first view of a week. */
  const [structState, setStructState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [narrState, setNarrState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  /** Wall-clock seconds since the narrative call started — drives
   *  the elapsed-time label inside the skeleton. */
  const [narrStartedAt, setNarrStartedAt] = useState<number | null>(null);
  const [narrElapsedMs, setNarrElapsedMs] = useState(0);
  /** Bumped on each load so a stale fetch's resolution can be
   *  ignored when the user has already navigated away. */
  const fetchSeq = useRef(0);
  const toast = useToast();

  const isCurrentWeek = useMemo(() => {
    const now = currentIsoWeek();
    return week.year === now.year && week.week === now.week;
  }, [week]);

  /** Two-phase load. Structured (meetings + actions) paints
   *  immediately; narrative (LLM) streams in separately. Setting
   *  `force=true` forces a regenerate on the narrative side only. */
  const load = useCallback(async (
    target: { year: number; week: number },
    force = false,
  ): Promise<void> => {
    const seq = ++fetchSeq.current;
    setStructState('loading');
    setErrorMsg(null);
    if (!force) {
      // On a normal week-change, drop the old narrative immediately
      // so the previous week's text doesn't bleed into the layout
      // while the new week's structured view paints.
      setNarrative(null);
    }

    // Track whether the structured fetch succeeded within this call
    // so the catch block knows which error state to set. (Using a
    // local variable avoids depending on structState in the useCallback
    // deps — that dependency caused an infinite re-render loop where
    // the structured fetch completing recreated load, re-fired the
    // useEffect, bumped fetchSeq, and silently discarded the in-flight
    // narrative response every time.)
    let structuredOk = false;

    // 1) Structured fetch — fast.
    try {
      const result = (await api.weekly.getStructured(target.year, target.week)) as WeeklyStructured;
      if (seq !== fetchSeq.current) return; // user navigated away
      setStructured(result);
      setStructState('ready');
      structuredOk = true;

      // 2) Narrative fetch — fires immediately after structured
      //    resolves so we know whether the cache is fresh (and
      //    thus whether to even show the "drafting" skeleton).
      if (result.meetings.length === 0 || result.inProgress) {
        // Empty week or current (still-in-progress) week — no
        // narrative to fetch. Current-week narratives are intentionally
        // skipped because meetings keep getting added all week and
        // any LLM output would be stale within hours.
        setNarrState('idle');
        return;
      }
      setNarrState('loading');
      setNarrStartedAt(Date.now());
      const narrResult = (await api.weekly.getNarrative(
        target.year, target.week, force,
      )) as WeeklyNarrativeResult;
      if (seq !== fetchSeq.current) return;
      setNarrative(narrResult);
      setNarrState('ready');
    } catch (e) {
      if (seq !== fetchSeq.current) return;
      // If structured already succeeded but narrative threw, the
      // structured layout stays visible and the narrative card
      // surfaces the error inline.
      const msg = e instanceof Error ? e.message : String(e);
      if (!structuredOk) {
        setStructState('error');
        setErrorMsg(msg);
      } else {
        setNarrState('error');
        setErrorMsg(msg);
      }
    }
  }, []);

  useEffect(() => {
    void load(week);
  }, [week, load]);

  // Tick the elapsed-time label while the narrative is loading.
  // Stops as soon as narrState leaves 'loading'.
  useEffect(() => {
    if (narrState !== 'loading' || narrStartedAt == null) {
      setNarrElapsedMs(0);
      return;
    }
    const id = setInterval(() => {
      setNarrElapsedMs(Date.now() - narrStartedAt);
    }, 250);
    return () => clearInterval(id);
  }, [narrState, narrStartedAt]);

  const onPrev = (): void => setWeek((w) => shiftWeek(w, -1));
  const onNext = (): void => {
    if (isCurrentWeek) return;
    setWeek((w) => shiftWeek(w, +1));
  };
  const onToday = (): void => setWeek(currentIsoWeek());

  // Direct week jump from the native week picker. Invalid values are
  // ignored (the input can emit '' mid-edit), and future weeks clamp to
  // the current one — same ceiling the ▶ arrow enforces.
  const onPickWeek = (value: string): void => {
    const picked = parseWeekInput(value);
    if (!picked) return;
    const now = currentIsoWeek();
    setWeek(compareIsoWeeks(picked, now) > 0 ? now : picked);
  };

  const onRegenerate = async (): Promise<void> => {
    await load(week, true);
  };

  const onExport = async (): Promise<void> => {
    try {
      const result = await api.weekly.exportMarkdown(week.year, week.week);
      if (result.path) {
        toast.show({ message: `Exported to ${result.path}`, durationMs: 4000 });
      } else {
        // Cancelled → fall back to clipboard.
        await navigator.clipboard.writeText(result.markdown);
        toast.show({ message: 'Markdown copied to clipboard', durationMs: 3000 });
      }
    } catch (e) {
      toast.show({ message: `Export failed: ${e instanceof Error ? e.message : String(e)}`, durationMs: 5000 });
    }
  };

  return (
    <div className="h-full max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 pt-4 sm:pt-6 lg:pt-8 flex flex-col">
      {/* Header — pinned via shrink-0; only the content region below scrolls,
          matching the Library page's top bar. */}
      <header className="shrink-0 flex items-center gap-4 mb-8">
        <div className="flex items-center gap-2.5">
          <img src={logoUrl} alt="MeetingNotes" className="h-9 w-auto" />
          <h1 className="text-lg font-semibold tracking-tight">MeetingNotes</h1>
        </div>
        <nav className="flex items-center gap-1 ml-4 text-sm">
          <button
            onClick={onBack}
            className="px-3 py-1.5 rounded-md text-ink-muted hover:text-ink hover:bg-surface-sunken transition"
          >
            Library
          </button>
          <button className="px-3 py-1.5 rounded-md bg-surface-sunken text-ink font-medium">
            Weekly
          </button>
        </nav>
        <div className="flex-1" />
        <div className="flex items-center gap-1">
          <button
            onClick={onPrev}
            className="w-8 h-8 rounded-md hover:bg-surface-sunken text-ink-muted flex items-center justify-center"
            title="Previous week"
          >
            <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2}>
              <path d="M15 18l-6-6 6-6" />
            </svg>
          </button>
          {/* Direct week jump. max caps the native picker at the current
              week (future weeks have nothing to show); onPickWeek still
              clamps in case the browser lets an out-of-range value
              through. Styled to sit flush with the arrow buttons. */}
          <input
            type="week"
            aria-label="Jump to week"
            title="Jump to a specific week"
            value={weekToInputValue(week)}
            max={weekToInputValue(currentIsoWeek())}
            onChange={(e) => onPickWeek(e.target.value)}
            className="text-sm text-ink-soft bg-surface border border-surface-border rounded-md
                       px-2 py-1 hover:border-ink/30 focus:outline-none focus:border-brand-indigo
                       focus:shadow-[0_0_0_3px_rgba(99,102,241,0.15)] [color-scheme:inherit]"
          />
          <button
            onClick={onToday}
            className="text-sm text-ink-soft px-2 py-1 hover:bg-surface-sunken rounded-md"
          >
            {isCurrentWeek ? 'This week' : 'Jump to current'}
          </button>
          <button
            onClick={onNext}
            disabled={isCurrentWeek}
            className={`w-8 h-8 rounded-md flex items-center justify-center ${
              isCurrentWeek ? 'text-ink-muted opacity-30 cursor-not-allowed' : 'text-ink-muted hover:bg-surface-sunken'
            }`}
            title="Next week"
          >
            <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2}>
              <path d="M9 18l6-6-6-6" />
            </svg>
          </button>
        </div>
        <button
          onClick={onExport}
          disabled={structState !== 'ready' || !structured || structured.meetings.length === 0}
          className="px-3 py-1.5 rounded-md bg-ink text-white text-sm font-medium hover:bg-ink-soft disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1.5"
        >
          Export
          <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2}>
            <path d="M12 3v12m0 0l-4-4m4 4l4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
          </svg>
        </button>
      </header>

      {/* Scroll region — content scrolls under the pinned header. The
          negative right margin + right padding insets the scrollbar so it
          doesn't crowd the cards (same trick as the Library list). */}
      <div className="flex-1 min-h-0 overflow-y-auto -mr-2 pr-2 pb-8">
      {structState === 'error' && (
        <div className="bg-status-warnBg text-status-warnText border border-status-warn/30 rounded-xl p-4 mb-6 text-sm">
          Couldn't load this week: {errorMsg ?? 'unknown error'}
        </div>
      )}

      {structState === 'loading' && !structured && (
        <div className="text-sm text-ink-muted">Loading…</div>
      )}

      {structured && (
        <WeeklyBody
          structured={structured}
          narrative={narrative}
          narrState={narrState}
          narrElapsedMs={narrElapsedMs}
          narrError={narrState === 'error' ? errorMsg : null}
          onRegenerate={onRegenerate}
          onOpenMeeting={onOpenMeeting}
        />
      )}
      </div>
    </div>
  );
}

interface BodyProps {
  structured: WeeklyStructured;
  narrative: WeeklyNarrativeResult | null;
  narrState: 'idle' | 'loading' | 'ready' | 'error';
  narrElapsedMs: number;
  narrError: string | null;
  onRegenerate: () => Promise<void>;
  onOpenMeeting: (id: string) => void;
}

function WeeklyBody({
  structured, narrative, narrState, narrElapsedMs, narrError, onRegenerate, onOpenMeeting,
}: BodyProps): JSX.Element {
  // Alias for the original prop name throughout the body so the
  // existing JSX further down keeps working without per-line edits.
  const data = structured;
  const empty = data.meetings.length === 0;

  return (
    <>
      <div className="mb-6">
        <div className="flex items-baseline gap-3 mb-2">
          <h2 className="font-mono text-[11px] tracking-[0.2em] uppercase text-ink-muted">
            {fmtRange(data.rangeStart, data.rangeEnd, data.isoYear)}
          </h2>
          {data.inProgress && (
            <span className="text-[11px] px-2 py-0.5 rounded-full bg-status-warnBg text-status-warnText font-medium">
              In progress
            </span>
          )}
        </div>
        <h1 className="text-3xl font-semibold tracking-tight mb-1">Weekly summary</h1>
        <div className="text-sm text-ink-muted">
          {data.meetings.length} meeting{data.meetings.length === 1 ? '' : 's'} ·{' '}
          {fmtTotalDuration(data.totalDurationS)} total · {data.openActionCount} open action
          item{data.openActionCount === 1 ? '' : 's'}
        </div>
      </div>

      {empty && (
        <div className="bg-surface rounded-xl shadow-card border border-surface-border p-10 text-center">
          <div className="text-ink-soft mb-1">No meetings captured this week.</div>
          <div className="text-xs text-ink-muted">
            Record a meeting and it'll show up here once processing finishes.
          </div>
        </div>
      )}

      {!empty && (
        <>
          {/* Narrative card. Four states: loading (skeleton + elapsed
              timer + meeting count), error (inline message + retry),
              ready (the rendered prose), and in-progress (no narrative
              yet — current week is still being filled in). */}
          <section className="mb-10">
            <NarrativeCard
              meetingCount={data.meetings.length}
              narrative={narrative}
              narrState={narrState}
              narrElapsedMs={narrElapsedMs}
              narrError={narrError}
              inProgress={data.inProgress}
              hasFreshCache={data.hasFreshCache}
              onRegenerate={onRegenerate}
            />
          </section>

          {/* Themes / threads — the recall payload. Lives in the narrative
              (LLM) payload, so it appears once the narrative resolves. */}
          {narrState === 'ready' && narrative && narrative.themes.length > 0 && (
            <section className="mb-10">
              <div className="flex items-baseline gap-3 mb-3">
                <h3 className="font-mono text-[11px] tracking-[0.2em] uppercase text-ink-muted">
                  Themes
                </h3>
                <span className="text-[11px] text-ink-muted">
                  {narrative.themes.length} thread{narrative.themes.length === 1 ? '' : 's'} this week
                </span>
              </div>
              <div className="flex flex-col gap-4">
                {narrative.themes.map((t, ti) => (
                  <div
                    key={ti}
                    className="bg-surface rounded-xl shadow-card border border-surface-border p-5"
                  >
                    <div className="font-semibold text-ink mb-1.5">{t.title}</div>
                    <div className="text-sm text-ink-soft leading-relaxed">{t.detail}</div>
                    {t.meetings.length > 0 && (
                      <div className="flex flex-wrap items-center gap-1.5 mt-3">
                        <span className="text-[11px] text-ink-muted">From:</span>
                        {t.meetings.map((title, mi) => {
                          const match = data.meetings.find((m) => m.title === title);
                          return match ? (
                            <button
                              key={mi}
                              type="button"
                              onClick={() => onOpenMeeting(match.id)}
                              className="text-[11px] font-medium text-brand-indigo bg-brand-indigo/5 hover:bg-brand-indigo/10 border border-brand-indigo/20 rounded-full px-2 py-0.5 transition"
                            >
                              {title}
                            </button>
                          ) : (
                            <span
                              key={mi}
                              className="text-[11px] text-ink-muted bg-surface-sunken border border-surface-border rounded-full px-2 py-0.5"
                            >
                              {title}
                            </span>
                          );
                        })}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Meetings */}
          <section className="mb-10">
            <div className="flex items-baseline gap-3 mb-3">
              <h3 className="font-mono text-[11px] tracking-[0.2em] uppercase text-ink-muted">
                Meetings
              </h3>
              <span className="text-[11px] text-ink-muted">{data.meetings.length} this week</span>
            </div>
            <div className="bg-surface rounded-xl shadow-card border border-surface-border divide-y divide-surface-border overflow-hidden">
              {data.meetings.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => onOpenMeeting(m.id)}
                  className="w-full flex items-center gap-4 px-5 py-3.5 hover:bg-surface-sunken text-left transition"
                >
                  <div className="text-xs text-ink-muted font-mono w-20 shrink-0">
                    {fmtDay(m.startedAt)} {fmtTimeShort(m.startedAt)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-ink truncate">{m.title}</div>
                    <div className="text-xs text-ink-muted">
                      {m.speakerCount != null
                        ? `${m.speakerCount} speaker${m.speakerCount === 1 ? '' : 's'}`
                        : 'Not yet diarized'}
                    </div>
                    {m.highlight && (
                      <div className="text-xs text-ink-soft mt-1 line-clamp-3">
                        {m.highlight}
                      </div>
                    )}
                  </div>
                  <div className="text-xs text-ink-muted font-mono shrink-0">
                    {fmtMeetingDuration(m.durationS)}
                  </div>
                  <svg viewBox="0 0 24 24" className="w-4 h-4 text-ink-muted shrink-0" fill="none" stroke="currentColor" strokeWidth={2}>
                    <path d="M9 18l6-6-6-6" />
                  </svg>
                </button>
              ))}
            </div>
          </section>

          {/* Open action items */}
          {data.openActionGroups.length > 0 && (
            <section className="mb-10">
              <div className="flex items-baseline gap-3 mb-3">
                <h3 className="font-mono text-[11px] tracking-[0.2em] uppercase text-ink-muted">
                  Open action items
                </h3>
                <span className="text-[11px] text-ink-muted">
                  {data.openActionCount} across {data.openActionGroups.length} owner{data.openActionGroups.length === 1 ? '' : 's'}
                </span>
              </div>
              {/* One card per owner with whitespace between, so multi-owner
                  weeks read as distinct buckets instead of one flat scroll.
                  isYou cards are tinted the whole way down (not just the
                  header) so "what's mine?" pops the moment the view opens.
                  Each item also repeats the owner badge — the header avatar
                  is below the fold once you scroll, the per-row one isn't. */}
              <div className="flex flex-col gap-6">
                {data.openActionGroups.map((group, gi) => {
                  const initials = group.isYou
                    ? 'YOU'
                    : group.ownerLabel.split(/\s+/).map((s) => s[0]).join('').slice(0, 2).toUpperCase();
                  const badgeStyle: React.CSSProperties = group.isYou
                    ? { background: 'linear-gradient(135deg,#6366f1,#8b5cf6)', color: '#ffffff' }
                    : { backgroundColor: '#f5f5f4', color: '#44403c' };
                  return (
                    <div
                      key={gi}
                      className={`rounded-xl shadow-card border overflow-hidden ${
                        group.isYou
                          ? 'bg-status-processingBg/40 border-status-processing/30'
                          : 'bg-surface border-surface-border'
                      }`}
                    >
                      <div className="px-5 pt-4 pb-2">
                        <div className="flex items-center gap-2.5">
                          <div
                            className="w-6 h-6 rounded-full text-[10px] font-semibold flex items-center justify-center shrink-0"
                            style={badgeStyle}
                          >
                            {initials}
                          </div>
                          <span className="text-sm font-medium">{group.ownerLabel}</span>
                          <span className="text-[11px] text-ink-muted">
                            {group.items.length} open
                          </span>
                        </div>
                      </div>
                      <div className="divide-y divide-surface-border/70">
                        {group.items.map((it) => {
                          const due = fmtDueLabel(it.dueDate, data.rangeEnd);
                          return (
                            <button
                              key={it.id}
                              type="button"
                              onClick={() => onOpenMeeting(it.meetingId)}
                              className="w-full flex items-center gap-3 px-5 py-3 hover:bg-surface-sunken text-left transition"
                            >
                              <div
                                className="w-4 h-4 rounded-full text-[8px] font-bold flex items-center justify-center shrink-0"
                                style={badgeStyle}
                                aria-hidden
                              >
                                {initials.slice(0, 2)}
                              </div>
                              <div className="flex-1 min-w-0">
                                <div className="text-sm text-ink truncate">{it.text}</div>
                                <div className="text-[11px] text-ink-muted truncate">
                                  From {it.meetingTitle} · {fmtDay(it.meetingStartedAt)}
                                </div>
                              </div>
                              {due.tier === 'overdue' ? (
                                <span className="text-[11px] px-2 py-0.5 rounded-full bg-danger-bg text-danger-text font-semibold shrink-0">
                                  {due.label}
                                </span>
                              ) : due.tier === 'this-week' ? (
                                <span className="text-[11px] px-2 py-0.5 rounded-full bg-status-warnBg text-status-warnText font-medium shrink-0">
                                  {due.label}
                                </span>
                              ) : due.tier === 'later' ? (
                                <span className="text-[11px] px-2 py-0.5 rounded-full bg-skeleton text-ink-muted font-medium shrink-0">
                                  {due.label}
                                </span>
                              ) : (
                                <span className="text-[11px] px-2 py-0.5 text-ink-muted shrink-0">
                                  {due.label}
                                </span>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {/* Decisions are part of the narrative payload — only show
              once it resolves. */}
          {narrative != null && narrative.decisions.length > 0 && (
            <section className="mb-10">
              <div className="flex items-baseline gap-3 mb-3">
                <h3 className="font-mono text-[11px] tracking-[0.2em] uppercase text-ink-muted">
                  Key decisions
                </h3>
                <span className="text-[11px] text-ink-muted">
                  {narrative.decisions.length} this week
                </span>
              </div>
              <div className="bg-surface rounded-xl shadow-card border border-surface-border p-6">
                <ul className="space-y-3 text-sm text-ink-soft">
                  {narrative.decisions.map((d, i) => (
                    <li key={i} className="flex items-start gap-3">
                      <div className="w-1 h-1 rounded-full bg-brand-indigo mt-2 shrink-0" />
                      <div>{d}</div>
                    </li>
                  ))}
                </ul>
              </div>
            </section>
          )}
        </>
      )}
    </>
  );
}

interface NarrativeCardProps {
  meetingCount: number;
  narrative: WeeklyNarrativeResult | null;
  narrState: 'idle' | 'loading' | 'ready' | 'error';
  narrElapsedMs: number;
  narrError: string | null;
  /** True when viewing the current (still-running) week. We skip
   *  narrative generation in that case because meetings keep getting
   *  added all week — show a friendly placeholder instead. */
  inProgress: boolean;
  /** True when this week's narrative is already cached against the current
   *  inputs. Lets the Regenerate button hint the cost up front — a fresh
   *  model call still runs regardless. */
  hasFreshCache: boolean;
  onRegenerate: () => Promise<void>;
}

/** Four-state narrative card:
 *
 *   - in-progress: friendly "available after the week ends" placeholder.
 *     Wins over all other states for the current ISO week.
 *   - loading: pulsing skeleton lines + elapsed timer + N-meetings hint.
 *     Sized to roughly match a real 3-paragraph narrative so the layout
 *     doesn't reflow when the real text arrives.
 *   - error:   inline error + a Retry button.
 *   - ready:   the rendered narrative + "Generated X ago" + Regenerate.
 */
function NarrativeCard({
  meetingCount, narrative, narrState, narrElapsedMs, narrError, inProgress, hasFreshCache, onRegenerate,
}: NarrativeCardProps): JSX.Element {
  const elapsedSec = Math.floor(narrElapsedMs / 1000);
  return (
    <div className="bg-surface rounded-xl shadow-card border border-surface-border p-6">
      <div className="flex items-center gap-2 mb-4">
        <div className="w-1.5 h-1.5 rounded-full"
          style={{ background: 'linear-gradient(135deg,#6366f1,#8b5cf6)' }} />
        <div className="font-mono text-[11px] tracking-[0.2em] uppercase text-ink-muted">
          Overview
        </div>
        {!inProgress && narrState === 'loading' && (
          <span className="text-[11px] text-ink-muted ml-2 inline-flex items-center gap-1.5">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-brand-indigo animate-pulse" />
            drafting from {meetingCount} meeting{meetingCount === 1 ? '' : 's'}
            {elapsedSec >= 1 && <span className="font-mono">· {elapsedSec}s</span>}
          </span>
        )}
        {!inProgress && narrState === 'ready' && narrative?.fromCache === false && (
          <span className="text-[11px] text-status-ok ml-2">just generated</span>
        )}
      </div>

      {inProgress && (
        <div className="text-sm text-ink-muted leading-relaxed">
          The week is still in progress, so the Overview is generated only
          after the week ends. The meetings, action items, and decisions
          below update live as new recordings finish processing.
        </div>
      )}

      {!inProgress && narrState === 'loading' && (
        <div aria-busy="true" aria-live="polite" className="space-y-2.5 animate-pulse">
          {/* Skeleton — 3 paragraphs of varying-length pulsing bars
              that approximate the LLM's typical 200-350 word output. */}
          <div className="h-3 bg-skeleton/80 rounded w-[96%]" />
          <div className="h-3 bg-skeleton/80 rounded w-[88%]" />
          <div className="h-3 bg-skeleton/80 rounded w-[92%]" />
          <div className="h-3 bg-skeleton/80 rounded w-[40%] mb-3" />
          <div className="h-3 bg-skeleton/80 rounded w-[94%]" />
          <div className="h-3 bg-skeleton/80 rounded w-[85%]" />
          <div className="h-3 bg-skeleton/80 rounded w-[60%] mb-3" />
          <div className="h-3 bg-skeleton/80 rounded w-[90%]" />
          <div className="h-3 bg-skeleton/80 rounded w-[55%]" />
          {elapsedSec >= 30 && (
            <div className="text-[11px] text-status-warnText pt-3 not-prose">
              Still working… large meetings can take 30–90 s on local LLMs. The
              window stays responsive — keep clicking around or close this tab.
            </div>
          )}
        </div>
      )}

      {!inProgress && narrState === 'error' && (
        <div className="bg-status-warnBg text-status-warnText border border-status-warn/30 rounded-lg p-3 text-sm">
          <div className="font-medium mb-1">Couldn't draft the narrative.</div>
          <div className="text-xs">{narrError ?? 'unknown error'}</div>
          <div className="text-xs mt-2 text-ink-muted">
            Common causes: LM Studio isn't running, no model is loaded, or the
            chosen model can't fit the prompt. The structured rollup below still
            works — only the Overview card needs the LLM.
          </div>
        </div>
      )}

      {!inProgress && narrState === 'ready' && narrative != null && (
        narrative.narrative ? (
          <div className="prose prose-sm max-w-none text-ink-soft leading-relaxed whitespace-pre-line">
            {narrative.narrative}
          </div>
        ) : (
          <div className="text-sm text-ink-muted italic">
            No narrative cached yet. Click Regenerate to produce one.
          </div>
        )
      )}

      {/* Footer hidden for in-progress weeks — there's nothing to
          regenerate and "Not yet generated" implies an action that
          isn't actually available. */}
      {!inProgress && (
        <div className="mt-5 pt-4 border-t border-surface-border flex items-center justify-between text-xs text-ink-muted">
          <span>
            {narrative?.generatedAt
              ? `Generated ${new Date(narrative.generatedAt).toLocaleString()}`
              : narrState === 'loading'
                ? '…'
                : 'Not yet generated'}
          </span>
          <button
            onClick={onRegenerate}
            disabled={narrState === 'loading'}
            title={
              hasFreshCache
                ? 'This week is already cached — regenerating will still take ~30s+ to call the model fresh.'
                : 'No cached narrative yet — first generation typically takes 30s+.'
            }
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md hover:bg-surface-sunken text-ink-soft hover:text-ink transition disabled:opacity-50"
          >
            <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2}>
              <path d="M21 12a9 9 0 1 1-3.5-7.1L21 8" />
              <path d="M21 3v5h-5" />
            </svg>
            {narrState === 'loading' ? 'Drafting…' : 'Regenerate (~30s)'}
          </button>
        </div>
      )}
    </div>
  );
}
