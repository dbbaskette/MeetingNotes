// electron/renderer/src/views/WeeklyView.tsx
//
// Real wired-up weekly view. Fetches structured data from the main
// process via api.weekly.get(year, week), renders the narrative +
// meetings + grouped action items + decisions, and lets the user
// regenerate the LLM narrative or export the whole thing as Markdown.
//
// Weekly payload shapes are shared through the IPC contract.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../ipc/client';
import { useToast } from '../components/Toasts';
import type { NavTarget } from '../components/AppNav';
import { AppHeader } from '../components/AppHeader';
import { weekToInputValue, parseWeekInput, compareIsoWeeks } from '../lib/week-input';
import { getIsoWeek as currentIsoWeek, addWeeks as shiftWeek } from '../../../shared/local-week';
import type { WeeklyStructured, WeeklyNarrative as WeeklyNarrativeResult } from '../../../main/ipc/contracts';
import { WeeklyBody } from './weekly/WeeklyBody';

interface Props {
  active?: boolean;
  /** Open the meeting detail view for the given id when a meeting
   *  row in the list is clicked. */
  onOpenMeeting: (id: string) => void;
  onNav: (target: NavTarget) => void;
}

export function WeeklyView({ active=true, onOpenMeeting, onNav }: Props): JSX.Element {
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
  /** Bumped on each load so a stale fetch's resolution can be
   *  ignored when the user has already navigated away. */
  const fetchSeq = useRef(0);
  const toast = useToast();
  const taskRefresh=useRef(0);
  function patchTask(id:string,patch:{status?:string;ownerName?:string|null;dueDate?:string|null}):void {
    if (structured?.savedAt) return;
    fetchSeq.current++;setNarrative(null);setNarrState('idle');
    setStructured(previous=>{
      if(!previous)return previous;
      const groups=previous.openActionGroups.map(group=>({...group,items:group.items.map(item=>item.id===id?{...item,...patch}:item)}));
      return {...previous,hasFreshCache:false,openActionGroups:groups,openActionCount:groups.reduce((sum,group)=>sum+group.items.filter(item=>item.status!=='done').length,0)};
    });
  }
  async function refreshTasks():Promise<void>{const sequence=++taskRefresh.current,navSequence=fetchSeq.current;const data=await api.weekly.getStructured(week.year,week.week) as WeeklyStructured;
    if(sequence===taskRefresh.current&&navSequence===fetchSeq.current)setStructured(data);
  }

  const isCurrentWeek = useMemo(() => {
    const now = currentIsoWeek();
    return week.year === now.year && week.week === now.week;
  }, [week]);

  /** Two-phase load. Structured (meetings + actions) paints
   *  immediately; narrative (LLM) streams in separately. Setting
   *  `force=true` replaces the whole report after successful generation. */
  const load = useCallback(async (
    target: { year: number; week: number },
    force = false,
  ): Promise<void> => {
    const seq = ++fetchSeq.current;
    if (!force) setStructState('loading');
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
      if (!result.savedAt && (result.meetings.length === 0 || result.inProgress)) {
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
      if (narrResult.snapshot) {
        setStructured({ ...narrResult.snapshot, hasFreshCache: true, savedAt: narrResult.generatedAt });
      }
      setNarrState('ready');
    } catch (e) {
      if (seq !== fetchSeq.current) return;
      // If structured already succeeded but narrative threw, the
      // structured layout stays visible and the narrative card
      // surfaces the error inline.
      // Drop Electron's "Error invoking remote method '…': Error:" wrapper so
      // the card shows LM Studio's actual explanation.
      const msg = (e instanceof Error ? e.message : String(e))
        .replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
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
    if(active)void load(week);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the ref is a request counter; cleanup must read its latest value
    return()=>{fetchSeq.current++;};
  }, [week, load, active]);

  // The elapsed-time label ticks inside the Overview card (it gets
  // `narrStartedAt`), not here: a 1 Hz state update at this root re-rendered
  // every meeting and task row while the report was drafting (#301).

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
    // pt-8 at every width keeps the header clear of the 28px window drag strip
    // (see LibraryView) so its buttons stay clickable edge to edge.
    <div className="app-view h-full max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 pt-8 flex flex-col">
      {/* Header — pinned via shrink-0; only the content region below scrolls,
          matching the Library page's top bar. */}
      <AppHeader active="weekly" onNav={onNav} navKey={active ? 'shown' : 'hidden'}>
        <div className="flex-1" />
        <div className="flex items-center gap-1">
          <button
            onClick={onPrev}
            className="w-8 h-8 rounded-md hover:bg-surface-sunken text-ink-muted flex items-center justify-center"
            title="Previous week"
            aria-label="Previous week"
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
            aria-label="Next week"
          >
            <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2}>
              <path d="M9 18l6-6-6-6" />
            </svg>
          </button>
        </div>
        <button
          onClick={onExport}
          disabled={structState !== 'ready' || !structured || (!structured.savedAt && structured.meetings.length === 0)}
          className="px-3 py-1.5 rounded-md bg-ink text-surface text-sm font-medium hover:bg-ink-soft disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1.5"
        >
          Export
          <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2}>
            <path d="M12 3v12m0 0l-4-4m4 4l4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
          </svg>
        </button>
      </AppHeader>

      {/* Scroll region — content scrolls under the pinned header. The
          negative right margin + right padding insets the scrollbar so it
          doesn't crowd the cards (same trick as the Library list). */}
      <div className="flex-1 min-h-0 overflow-y-auto -mr-2 pr-2 pb-8">
      {structState === 'error' && (
        <div role="alert" className="bg-status-warnBg text-status-warnText border border-status-warn/30 rounded-xl p-4 mb-6 text-sm">
          Couldn&apos;t load this week: {errorMsg ?? 'unknown error'}
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
          narrStartedAt={narrStartedAt}
          narrError={narrState === 'error' ? errorMsg : null}
          onRegenerate={onRegenerate}
          onOpenMeeting={onOpenMeeting}
          onTaskPatch={patchTask} onTasksSaved={refreshTasks}
        />
      )}
      </div>
    </div>
  );
}
