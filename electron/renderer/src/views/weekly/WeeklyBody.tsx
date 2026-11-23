import { useMemo, useState } from 'react';
import { WeeklyTaskRow } from '../../components/WeeklyTaskRow';
import type { WeeklyStructured, WeeklyNarrative as WeeklyNarrativeResult } from '../../../../main/ipc/contracts';
import { NarrativeCard } from './NarrativeCard';

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
    month: 'short', day: 'numeric',
  });
  return `Week of ${fmt(rangeStart)} – ${fmt(rangeEnd)}, ${year}`;
}

interface BodyProps {
  onTaskPatch:(id:string,patch:{status?:string;ownerName?:string|null;dueDate?:string|null})=>void;
  onTasksSaved:()=>Promise<void>;
  structured: WeeklyStructured;
  narrative: WeeklyNarrativeResult | null;
  narrState: 'idle' | 'loading' | 'ready' | 'error';
  narrStartedAt: number | null;
  narrError: string | null;
  onRegenerate: () => Promise<void>;
  onOpenMeeting: (id: string) => void;
}

export function WeeklyBody({
  structured, narrative, narrState, narrStartedAt, narrError, onRegenerate, onOpenMeeting, onTaskPatch, onTasksSaved,
}: BodyProps): JSX.Element {
  // Alias for the original prop name throughout the body so the
  // existing JSX further down keeps working without per-line edits.
  const data = structured;
  const empty = data.meetings.length === 0 && !data.savedAt;
  const [taskFilter,setTaskFilter]=useState<'all'|'mine'|'overdue'|'week'>('all');
  const snapshotDate=data.capturedAt??data.savedAt;
  const today=snapshotDate?new Date(snapshotDate):new Date();const todayString=`${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
  const filteredGroups=useMemo(()=>data.openActionGroups.map(group=>({...group,items:group.items.filter(item=>taskFilter==='all'||taskFilter==='mine'&&item.isYou||taskFilter==='overdue'&&!!item.dueDate&&item.dueDate<todayString||taskFilter==='week'&&!!item.dueDate&&new Date(`${item.dueDate}T12:00:00`).getTime()>=Date.parse(data.rangeStart)&&new Date(`${item.dueDate}T12:00:00`).getTime()<=Date.parse(data.rangeEnd))})).filter(group=>group.items.length>0),[data.openActionGroups,data.rangeStart,data.rangeEnd,taskFilter,todayString]);

  return (
    <>
      <div className="mb-6">
        <div className="flex items-baseline gap-3 mb-2">
          <h2 className="report-heading text-ink-muted">
            {fmtRange(data.rangeStart, data.rangeEnd, data.isoYear)}
          </h2>
          {data.inProgress && (
            <span className="text-[11px] px-2 py-0.5 rounded-full bg-status-warnBg text-status-warnText font-medium">
              In progress
            </span>
          )}
          {data.savedAt && <span className="text-[11px] px-2 py-0.5 rounded-full bg-surface-sunken text-status-ok font-medium">Saved report</span>}
        </div>
        <h1 className="text-3xl font-semibold tracking-tight mb-1">Weekly summary</h1>
        <div className="text-sm text-ink-muted">
          {data.meetings.length} meeting{data.meetings.length === 1 ? '' : 's'} ·{' '}
          {fmtTotalDuration(data.totalDurationS)} total · {data.openActionCount} open action
          item{data.openActionCount === 1 ? '' : 's'}
        </div>
        {data.savedAt && <p className="text-xs text-ink-muted mt-3">
          This report stays unchanged. Regenerate to replace it with the latest meeting notes and actions.
          {data.legacySnapshot && ' Older versions saved only the generated text; meeting and action sections were captured when this report was first opened after upgrading.'}
        </p>}
      </div>

      {empty && (
        <div className="report-section bg-surface rounded-xl shadow-card border border-surface-border p-10 text-center">
          <div className="text-ink-soft mb-1">No meetings captured this week.</div>
          <div className="text-xs text-ink-muted">
            Record a meeting and it&apos;ll show up here once processing finishes.
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
              narrStartedAt={narrStartedAt}
              narrError={narrError}
              inProgress={data.inProgress}
              hasFreshCache={data.hasFreshCache}
              onRegenerate={onRegenerate}
            />
          </section>

          {/* Themes / threads — the recall payload. Lives in the narrative
              (LLM) payload, so it appears once the narrative resolves. */}
          {narrative && narrative.themes.length > 0 && (
            <section className="mb-10">
              <div className="flex items-baseline gap-3 mb-3">
                <h3 className="report-heading text-ink-muted">
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
                    className="report-section bg-surface rounded-xl shadow-card border border-surface-border p-5"
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
              <h3 className="report-heading text-ink-muted">
                Meetings
              </h3>
              <span className="text-[11px] text-ink-muted">{data.meetings.length} this week</span>
            </div>
            <div className="report-section bg-surface rounded-xl shadow-card border border-surface-border divide-y divide-surface-border overflow-hidden">
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
                <h3 className="report-heading text-ink-muted">
                  {data.savedAt ? 'Open actions in saved report' : 'Open action items'}
                </h3>
                <span className="text-[11px] text-ink-muted">
                  {data.openActionCount} across {data.openActionGroups.length} owner{data.openActionGroups.length === 1 ? '' : 's'}
                </span>
              </div>
              {data.savedAt && <p className="text-xs text-ink-muted mb-3">Historical snapshot. Open the source meeting to manage its current tasks.</p>}
              {/* One card per owner with whitespace between, so multi-owner
                  weeks read as distinct buckets instead of one flat scroll.
                  isYou cards are tinted the whole way down (not just the
                  header) so "what's mine?" pops the moment the view opens.
                  Each item also repeats the owner badge — the header avatar
                  is below the fold once you scroll, the per-row one isn't. */}
              <div className="flex flex-col gap-6">
                <div className="flex flex-wrap gap-2 text-xs">{(['all','mine','overdue','week'] as const).map(filter=><button key={filter} aria-pressed={filter===taskFilter} onClick={()=>setTaskFilter(filter)} className={`rounded-full border px-3 py-1 ${taskFilter===filter?'border-brand-indigo text-brand-indigo':'border-surface-border text-ink-muted'}`}>{filter==='week'?'Due this week':filter==='mine'?'Mine':filter==='all'?'All open':'Overdue'}</button>)}</div>
                {filteredGroups.length===0&&<p className="text-sm text-ink-muted">No open actions match this filter.</p>}
                {filteredGroups.map((group, gi) => {
                  const initials = group.isYou
                    ? 'YOU'
                    : group.ownerLabel.split(/\s+/).map((s) => s[0]).join('').slice(0, 2).toUpperCase();
                  const badgeClass = group.isYou ? 'brand-fill text-white' : 'bg-surface-sunken text-ink-soft';
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
                            className={`w-6 h-6 rounded-full text-[10px] font-semibold flex items-center justify-center shrink-0 ${badgeClass}`}
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
                        {group.items.map(it=><WeeklyTaskRow key={it.id} item={it} rangeEnd={data.rangeEnd} savedAt={data.savedAt ? snapshotDate : undefined} onOpen={onOpenMeeting} onPatch={onTaskPatch} onSaved={onTasksSaved}/>)}
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
                <h3 className="report-heading text-ink-muted">
                  Key decisions
                </h3>
                <span className="text-[11px] text-ink-muted">
                  {narrative.decisions.length} this week
                </span>
              </div>
              <div className="report-section bg-surface rounded-xl shadow-card border border-surface-border p-6">
                <ul className="space-y-3 text-sm text-ink-soft">
                  {narrative.decisions.map((d, i) => (
                    <li key={i} className="flex items-start gap-3">
                      <div className="w-1 h-1 rounded-full bg-brand-solid mt-2 shrink-0" />
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
