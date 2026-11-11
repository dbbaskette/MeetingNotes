// Pure text handling for "ask across meetings": cut notes and transcripts
// into passages small enough to rank and to hand to a local model, and turn
// a question into a full-text query.

export interface Passage {
  kind: 'summary' | 'transcript';
  /** Transcript passages: seconds from the start of the recording. */
  startS: number | null;
  /** Summary passages: the section heading the text sits under. */
  heading: string | null;
  text: string;
}

const TRANSCRIPT_LINE = /^\[(.+?)\s+((?:\d+:)?\d{1,2}:\d{2})\]\s*(.*)$/;
const PASSAGE_CHARS = 900;

function seconds(clock: string): number {
  return clock.split(':').reduce((total, part) => total * 60 + Number(part), 0);
}

/** Group `[Speaker mm:ss] text` lines into passages of a few turns each, so a
 *  hit carries enough surrounding talk to answer from. Consecutive lines by
 *  one speaker are written once under their name. */
export function chunkTranscript(markdown: string, maxChars = PASSAGE_CHARS): Passage[] {
  const passages: Passage[] = [];
  let lines: string[] = [], size = 0, startS: number | null = null, lastSpeaker: string | null = null;
  const flush = (): void => {
    if (lines.length) passages.push({ kind: 'transcript', startS, heading: null, text: lines.join('\n') });
    lines = []; size = 0; startS = null; lastSpeaker = null;
  };
  for (const raw of markdown.split('\n')) {
    const match = TRANSCRIPT_LINE.exec(raw.trim());
    if (!match) continue;
    const [, speaker, clock, said] = match as unknown as [string, string, string, string];
    const text = said.trim();
    if (!text) continue;
    if (size + text.length > maxChars && lines.length) flush();
    if (startS === null) startS = seconds(clock);
    if (speaker === lastSpeaker) lines[lines.length - 1] += ` ${text}`;
    else lines.push(`${speaker}: ${text}`);
    lastSpeaker = speaker;
    size += text.length;
  }
  flush();
  return passages;
}

/** One passage per `##` section of the notes, split on paragraphs when a
 *  section is long. Text before the first heading is kept too. */
export function chunkSummary(markdown: string, maxChars = PASSAGE_CHARS * 1.5): Passage[] {
  const passages: Passage[] = [];
  let heading: string | null = null, buffer: string[] = [];
  const flush = (): void => {
    const paragraphs = buffer.join('\n').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
    let text = '';
    for (const paragraph of paragraphs) {
      if (text && text.length + paragraph.length > maxChars) { passages.push({ kind: 'summary', startS: null, heading, text }); text = ''; }
      text = text ? `${text}\n${paragraph}` : paragraph;
    }
    if (text) passages.push({ kind: 'summary', startS: null, heading, text });
    buffer = [];
  };
  for (const line of markdown.split('\n')) {
    const title = /^#{1,3}\s+(.*)$/.exec(line);
    if (title) { flush(); heading = title[1]!.trim() || null; } else buffer.push(line);
  }
  flush();
  return passages;
}

const STOPWORDS = new Set(('a an and are as at be been but by can could did do does for from had has have he her his how i if in into is it its '
  + 'just me my of on or our said say says she so some than that the their them then there these they this to up us was we were what when where '
  + 'which who whom whose why will with would you your about any all also am did discussed discuss mention mentioned meeting meetings talk talked tell').split(' '));

/** Content words of a question, in order, without duplicates. */
export function questionTerms(question: string, limit = 12): string[] {
  const seen = new Set<string>();
  for (const word of question.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []) {
    const clean = word.replace(/['’]s$/, '').replace(/['’-]+$/, '');
    if (clean.length < 2 || STOPWORDS.has(clean) || seen.has(clean)) continue;
    seen.add(clean);
    if (seen.size === limit) break;
  }
  return [...seen];
}

/** An FTS5 MATCH expression that ranks passages containing more of the terms
 *  higher. Every term is quoted, so nothing a user types is read as query
 *  syntax. Null when there is nothing to search for. */
export function ftsQuery(terms: readonly string[]): string | null {
  const quoted = terms.map((term) => term.replace(/"/g, '').trim()).filter(Boolean).map((term) => `"${term}"`);
  return quoted.length ? quoted.join(' OR ') : null;
}
