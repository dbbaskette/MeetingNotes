/** Shapes shared by the main process and the renderer for asking a question
 *  across all meetings. */
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
export interface AskResult {
  answer: string;
  sources: AskSource[];
  /** False when the library held nothing relevant; `answer` then says so. */
  found: boolean;
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
