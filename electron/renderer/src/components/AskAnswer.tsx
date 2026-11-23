// The answer pane for "Ask your meetings" (#254): the ⌘K palette's Ask mode
// and the meeting page's "Ask about this meeting" both render it. The
// answer comes from the notes and transcripts in scope, with numbered
// sources the caller decides how to open, and a line saying where the
// model ran.
import { useEffect, useState } from 'react';
import { api } from '../ipc/client';
import { answerParts, endpointNotice, type AskResult, type AskScope, type AskSource } from '../../../shared/ask';

type State = { kind: 'loading' } | { kind: 'done'; result: AskResult } | { kind: 'error'; message: string };

function clock(seconds: number): string {
  const m = Math.floor(seconds / 60);
  return `${m}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`;
}

export function AskAnswer({ question, scope, onOpen, onBack, backLabel = 'Back to results', className = 'max-h-[60vh] overflow-y-auto px-4 py-3' }: {
  question: string;
  /** Omitted: the whole library. */
  scope?: AskScope;
  onOpen: (source: AskSource) => void;
  onBack: () => void;
  backLabel?: string;
  className?: string;
}): JSX.Element {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  // A stable key, so a new facets object with the same filters does not ask again.
  const scopeKey = JSON.stringify(scope ?? {});
  useEffect(() => {
    let alive = true;
    setState({ kind: 'loading' });
    api.search.ask(question, JSON.parse(scopeKey) as AskScope).then(
      (result) => { if (alive) setState({ kind: 'done', result }); },
      (error: unknown) => { if (alive) setState({ kind: 'error', message: error instanceof Error ? error.message : String(error) }); },
    );
    // Leaving the answer stops the model working on a question nobody is waiting for.
    return () => { alive = false; void api.search.cancelAsk(); };
  }, [question, scopeKey, attempt]);

  const oneMeeting = scope?.meetingId !== undefined;
  const sources = state.kind === 'done' ? state.result.sources : [];
  const byNumber = new Map(sources.map((source) => [source.n, source]));
  return (
    <div className={className} aria-live="polite">
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs text-ink-muted"><span className="font-semibold text-ink">Asked:</span> {question}</p>
        <button type="button" onClick={onBack}
          className="shrink-0 rounded text-xs font-semibold text-brand-indigo underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-indigo/40">{backLabel}</button>
      </div>
      {state.kind === 'done' && state.result.scopeLabel && (
        <p className="mt-1 text-[11px] text-ink-muted">{state.result.scopeLabel}</p>
      )}
      {state.kind === 'loading' && (
        <p role="status" className="mt-4 text-sm text-ink-muted">
          {oneMeeting ? 'Reading this meeting…' : 'Reading your meetings…'} The answer can take a minute.
        </p>
      )}
      {state.kind === 'error' && (
        <p role="alert" className="mt-4 text-sm text-ink-muted">
          Couldn&apos;t answer: <span className="text-ink">{state.message}</span>{' '}
          <button type="button" onClick={() => setAttempt((n) => n + 1)} className="rounded font-semibold text-brand-indigo underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-indigo/40">Retry</button>
        </p>
      )}
      {state.kind === 'done' && (
        <>
          <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-ink">
            {answerParts(state.result.answer, Math.max(0, ...sources.map((s) => s.n))).map((part, i) => {
              if ('text' in part) return <span key={i}>{part.text}</span>;
              const source = byNumber.get(part.cite);
              return source
                ? <button key={i} type="button" onClick={() => onOpen(source)} title={source.title}
                    aria-label={`Source ${part.cite}: ${oneMeeting ? sourcePlace(source) : source.title}`}
                    className="mx-0.5 rounded bg-brand-indigo/10 px-1 text-[11px] font-semibold text-brand-indigo hover:bg-brand-indigo/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-indigo/40">{part.cite}</button>
                : <span key={i}>[{part.cite}]</span>;
            })}
          </p>
          {sources.length > 0 && (
            <ol className="mt-4 space-y-1.5" aria-label="Sources">
              {sources.map((source) => (
                <li key={source.n}>
                  <button type="button" onClick={() => onOpen(source)}
                    className="w-full rounded-lg border border-surface-border px-3 py-2 text-left hover:border-brand-indigo/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-indigo/40">
                    <span className="flex flex-wrap items-center gap-2 text-xs text-ink-muted">
                      <span className="rounded bg-brand-indigo/10 px-1 text-[11px] font-semibold text-brand-indigo">{source.n}</span>
                      {!oneMeeting && <span className="font-semibold text-ink">{source.title}</span>}
                      {!oneMeeting && source.startedAt && <span>{source.startedAt.slice(0, 10)}</span>}
                      <span className="font-mono text-[10px] uppercase tracking-wider">{sourcePlace(source)}</span>
                    </span>
                    <span className="mt-0.5 block whitespace-pre-wrap text-xs text-ink-soft">{source.snippet}</span>
                  </button>
                </li>
              ))}
            </ol>
          )}
          <p className="mt-3 text-[11px] text-ink-muted">
            {endpointNotice(state.result.endpoint, state.result.asked)}
            {sources.length > 0 && ' Check the source before relying on an answer.'}
          </p>
        </>
      )}
    </div>
  );
}

/** "transcript · 12:34" or the notes section a source came from. */
function sourcePlace(source: AskSource): string {
  return source.kind === 'transcript'
    ? `transcript${source.startS !== null ? ` · ${clock(source.startS)}` : ''}`
    : source.heading ?? 'notes';
}
