// Pure rules for "Ask about this meeting" (#254), kept out of the component
// so they can be tested without a DOM.
import type { AskSource } from '../../../../shared/ask';
import type { Tab } from './types';

/** Shortest question worth sending, as in the ⌘K palette. */
export const MIN_QUESTION = 3;

/** Asking needs something to read: notes or a merged transcript (the raw
 *  pre-merge text is not indexed). */
export function canAskMeeting(m: { summaryMd: string | null; transcriptMd: string | null }): boolean {
  return Boolean(m.summaryMd?.trim() || m.transcriptMd?.trim());
}

export type CitationAction = { kind: 'seek'; seconds: number; tab: Tab } | { kind: 'tab'; tab: Tab };

/** What following a source does on the meeting page: a timed transcript
 *  passage seeks the player in place and shows the transcript; anything
 *  else switches to the tab it came from. */
export function citationAction(source: Pick<AskSource, 'kind' | 'startS'>): CitationAction {
  if (source.kind === 'transcript')
    return source.startS !== null ? { kind: 'seek', seconds: source.startS, tab: 'transcript' } : { kind: 'tab', tab: 'transcript' };
  return { kind: 'tab', tab: 'summary' };
}
