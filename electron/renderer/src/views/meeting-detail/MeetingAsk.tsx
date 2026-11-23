// electron/renderer/src/views/meeting-detail/MeetingAsk.tsx
// "Ask about this meeting" (#254): a one-line question box above the
// meeting's tabs. It asks the same service as ⌘K, restricted to this
// meeting, and renders the answer with the shared AskAnswer. Following a
// transcript source seeks the player in place; a notes source opens the
// Notes tab. Nothing is stored: closing the answer or leaving the page
// cancels a question still being answered.
import { useEffect, useId, useRef, useState } from 'react';
import { AskAnswer } from '../../components/AskAnswer';
import type { AskSource } from '../../../../shared/ask';
import { citationAction, MIN_QUESTION } from './meeting-ask';
import type { Tab } from './types';

export function MeetingAsk({ meetingId, onSeek, onTab }: {
  meetingId: string;
  /** The page's player seek (usePlayback's seekTo). */
  onSeek: (seconds: number) => void;
  onTab: (tab: Tab) => void;
}): JSX.Element {
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();
  // Another meeting starts with an empty box.
  useEffect(() => { setQuestion(''); setAsking(null); }, [meetingId]);

  const trimmed = question.trim();
  const canAsk = trimmed.length >= MIN_QUESTION && trimmed !== asking;
  const close = (): void => { setAsking(null); inputRef.current?.focus(); };
  const follow = (source: AskSource): void => {
    const action = citationAction(source);
    onTab(action.tab);
    if (action.kind === 'seek') onSeek(action.seconds);
  };

  return (
    <section aria-label="Ask about this meeting" className="border-b border-surface-border px-5 py-3">
      <form
        className="flex items-center gap-2"
        onSubmit={(event) => { event.preventDefault(); if (canAsk) setAsking(trimmed); }}
      >
        <label htmlFor={inputId} className="sr-only">Ask about this meeting</label>
        <input
          ref={inputRef} id={inputId} type="text" maxLength={2000} value={question}
          placeholder="Ask about this meeting…"
          onChange={(event) => { setQuestion(event.target.value); setAsking(null); }}
          onKeyDown={(event) => {
            if (event.key !== 'Escape' || (asking === null && !question)) return;
            // Esc closes the answer (cancelling it), then clears the box.
            event.preventDefault();
            event.stopPropagation();
            if (asking !== null) setAsking(null); else setQuestion('');
          }}
          className="flex-1 min-w-0 rounded-lg border border-surface-border bg-surface px-3 py-1.5 text-sm text-ink placeholder:text-ink-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-indigo/40"
        />
        <button
          type="submit" disabled={!canAsk}
          title="Answer this question from this meeting's notes and transcript (Enter)"
          className="shrink-0 rounded-md bg-brand-solid px-2.5 py-1.5 text-xs font-semibold text-white disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-indigo/40"
        >
          Ask
        </button>
      </form>
      {asking !== null && (
        <AskAnswer
          question={asking} scope={{ meetingId }} onOpen={follow} onBack={close} backLabel="Close"
          className="mt-2 max-h-[40vh] overflow-y-auto rounded-lg bg-surface-sunken px-3 py-2"
        />
      )}
    </section>
  );
}
