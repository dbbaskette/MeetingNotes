import type { SearchFacets } from './search';

/** Shapes shared by the main process and the renderer for asking a question
 *  across all meetings, across the meetings the search filters allow, or
 *  inside one meeting. */
export interface AskSource {
  /** The number the answer cites, as in [2]. */
  n: number;
  meetingId: string;
  title: string;
  startedAt: string | null;
  kind: 'summary' | 'transcript';
  /** Transcript passages: seconds from the start of the recording. */
  startS: number | null;
  heading: string | null;
  snippet: string;
}

/** What a question is asked over: one meeting, or the library narrowed by
 *  the same filters ⌘K search uses. Omitted means the whole library. */
export interface AskScope {
  meetingId?: string;
  facets?: SearchFacets;
}

/** Where the model that answers runs. Only the host is ever given, never
 *  the full URL (it can carry credentials or a path). */
export type AskEndpoint = { local: true } | { local: false; host: string };

export interface AskResult {
  answer: string;
  sources: AskSource[];
  /** False when nothing relevant was found; `answer` then says so. */
  found: boolean;
  /** True when the question and passages went to the model. False when no
   *  passage matched, so nothing was sent anywhere. */
  asked: boolean;
  endpoint: AskEndpoint;
  /** "Asked across 12 meetings, in week 2026-W46, with Alice" when search
   *  filters narrowed the question; null otherwise. */
  scopeLabel: string | null;
}

/** One line saying where the answer was written. Truthful about what left
 *  the Mac: nothing does when the model was not asked. */
export function endpointNotice(endpoint: AskEndpoint, asked: boolean): string {
  if (endpoint.local) return 'Ran on this Mac: the question and the passages stayed here.';
  if (!asked) return `Nothing was sent to ${endpoint.host}: no passage matched the question.`;
  return `Your question and the quoted passages were sent to ${endpoint.host}, the model endpoint set in Settings.`;
}

/** Split an answer into text and citation markers, so the renderer can turn
 *  [n] into a link without parsing model output as markup. */
export function answerParts(answer: string, maxSource: number): ({ text: string } | { cite: number })[] {
  const parts: ({ text: string } | { cite: number })[] = [];
  let last = 0;
  for (const match of answer.matchAll(/\[(\d{1,2})\]/g)) {
    const n = Number(match[1]);
    if (n < 1 || n > maxSource) continue;
    if (match.index > last) parts.push({ text: answer.slice(last, match.index) });
    parts.push({ cite: n });
    last = match.index + match[0].length;
  }
  if (last < answer.length) parts.push({ text: answer.slice(last) });
  return parts;
}
