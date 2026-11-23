import { useEffect, useState } from 'react';
import { isContextOverflowError } from '../../lib/context-overflow';
import type { WeeklyNarrative as WeeklyNarrativeResult } from '../../../../main/ipc/contracts';

interface NarrativeCardProps {
  meetingCount: number;
  narrative: WeeklyNarrativeResult | null;
  narrState: 'idle' | 'loading' | 'ready' | 'error';
  narrStartedAt: number | null;
  narrError: string | null;
  /** True when viewing the current (still-running) week. We skip
   *  narrative generation in that case because meetings keep getting
   *  added all week — show a friendly placeholder instead. */
  inProgress: boolean;
  /** Compatibility name: true when the week has a saved report. */
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
export function NarrativeCard({
  meetingCount, narrative, narrState, narrStartedAt, narrError, inProgress, hasFreshCache, onRegenerate,
}: NarrativeCardProps): JSX.Element {
  // Ticks only while the narrative is loading, and only re-renders this card.
  const [elapsedSec, setElapsedSec] = useState(0);
  useEffect(() => {
    if (narrState !== 'loading' || narrStartedAt == null) { setElapsedSec(0); return; }
    const tick = (): void => setElapsedSec(Math.floor((Date.now() - narrStartedAt) / 1000));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [narrState, narrStartedAt]);
  return (
    <div className="report-section bg-surface rounded-xl shadow-card border border-surface-border p-6">
      <div className="flex items-center gap-2 mb-4">
        <div className="brand-fill w-1.5 h-1.5 rounded-full" />
        <div className="report-heading text-ink-muted">
          Overview
        </div>
        {!inProgress && narrState === 'loading' && (
          <span className="text-[11px] text-ink-muted ml-2 inline-flex items-center gap-1.5">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-brand-solid animate-pulse" />
            {narrative ? 'updating saved report' : `drafting from ${meetingCount} meeting${meetingCount === 1 ? '' : 's'}`}
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
          after the week ends. The meetings and action items
          below update live as new recordings finish processing.
        </div>
      )}

      {!inProgress && narrState === 'loading' && !narrative && (
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
        <div role="alert" className="bg-status-warnBg text-status-warnText border border-status-warn/30 rounded-lg p-3 text-sm">
          <div className="font-medium mb-1">Couldn&apos;t generate the report.</div>
          <div className="text-xs">{narrError ?? 'unknown error'}</div>
          <div className="text-xs mt-2 text-ink-muted">
            {narrative && 'Your saved report has not been changed. '}
            {isContextOverflowError(narrError)
              ? 'The structured rollup below still works — only the Overview card needs the LLM.'
              : <>Common causes: LM Studio isn&apos;t running, no model is loaded, or the
                chosen model can&apos;t fit the prompt. The structured rollup below still
                works — only the Overview card needs the LLM.</>}
          </div>
        </div>
      )}

      {!inProgress && narrative != null && (
        narrative.narrative ? (
          <div className="prose prose-sm max-w-none text-ink-soft leading-relaxed whitespace-pre-line">
            {narrative.narrative}
          </div>
        ) : (
          <div className="text-sm text-ink-muted italic">
            No overview text. Click Regenerate to produce one.
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
                ? 'Replace this saved report using the latest notes and actions. Requires a new model call (~30s+).'
                : 'Generate and save this report. Typically takes 30s+.'
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
