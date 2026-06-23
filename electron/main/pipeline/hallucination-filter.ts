// electron/main/pipeline/hallucination-filter.ts
//
// Whisper reliably emits a small handful of boilerplate phrases when it's
// fed silence or low-information audio. Common offenders:
//   "Thank you" / "Thank you." — the most frequent, fired on any silent
//     chunk, especially on the voice stem (mic captures the user's room
//     while they're listening to the other side)
//   "Thanks for watching." / "Subscribe to my channel." — YouTube-video-
//     style phrasing leaked from the training set
//   "[BLANK_AUDIO]" / "[Music]" / "[Applause]" — meta-tokens emitted in
//     place of an empty transcription
//   "You" / "you" — bare pronoun, often whisper's minimum-output for a
//     silent slot
//
// Two filters here:
//
//   isWhisperNoise(text)
//     Unconditional drop for phrases that are effectively never spoken
//     in a business meeting. Case-insensitive, whitespace-normalised
//     exact match against a small allowlist.
//
//   filterHallucinations(segments)
//     Runs isWhisperNoise + a second-pass "repeated thank-you" cluster
//     detector. Single "thank you" in a transcript is probably a real
//     polite closing; three "thank you"s on a silent voice stem is
//     whisper hallucinating every time the mic went quiet. When we see
//     two or more "thank you" variants, drop all of them.

export interface Segmentish { start: number; end: number; text: string; }

const COMMON_WHISPER_NOISE = new Set<string>([
  '[blank_audio]',
  '[music]',
  '[applause]',
  '[laughter]',
  '[silence]',
  'thanks for watching.',
  'thanks for watching!',
  'thanks for watching, everyone.',
  'thank you for watching.',
  'subscribe to my channel.',
  'please subscribe.',
  'like and subscribe.',
  'you',
  'you.',
  'bye.',
  'bye!',
  'bye-bye.',
]);

export function isWhisperNoise(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/\s+/g, ' ');
  return COMMON_WHISPER_NOISE.has(t);
}

/** Minimum length of a consecutive identical-sentence run before we treat it
 *  as a whisper decoder repetition loop (vs. genuine emphatic repetition like
 *  "Yes. Yes."). Four verbatim repeats in a row is effectively never real
 *  speech; the loops we see run from a dozen to many hundreds. */
const MIN_REPEAT_RUN = 4;

function norm(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Collapse runs of the SAME sentence repeated consecutively within a string
 *  down to a single instance. Whisper repetition loops emit the looped
 *  sentence over and over inside one segment's text; this strips the run while
 *  keeping one copy (so a real first utterance survives) and leaving the
 *  surrounding non-looped sentences intact. Runs shorter than
 *  {@link MIN_REPEAT_RUN} are preserved. */
export function collapseRepeatedSentences(text: string, minRun = MIN_REPEAT_RUN): string {
  // Split keeping sentence-final punctuation attached to each sentence.
  const parts = text.split(/(?<=[.!?])\s+/);
  const out: string[] = [];
  let i = 0;
  while (i < parts.length) {
    const key = norm(parts[i]!);
    let j = i;
    if (key.length > 0) {
      while (j + 1 < parts.length && norm(parts[j + 1]!) === key) j += 1;
    }
    const runLen = j - i + 1;
    if (runLen >= minRun) {
      out.push(parts[i]!); // keep a single copy of the looped sentence
    } else {
      for (let k = i; k <= j; k += 1) out.push(parts[k]!);
    }
    i = j + 1;
  }
  return out.join(' ');
}

/** Collapse whisper repetition loops across a segment stream. First squashes
 *  intra-segment repeated sentences, drops segments that become empty, then
 *  collapses a run of consecutive segments with identical text down to the
 *  first one. Catches loops that play out within a single segment AND loops
 *  that span dozens of consecutive segments (the TanzuLive failure mode). */
export function collapseRepetitionLoops<T extends Segmentish>(
  segments: readonly T[],
  minRun = MIN_REPEAT_RUN,
): T[] {
  const collapsed = segments
    .map((s) => ({ ...s, text: collapseRepeatedSentences(s.text, minRun) }))
    .filter((s) => s.text.trim().length > 0);

  const out: T[] = [];
  let i = 0;
  while (i < collapsed.length) {
    const key = norm(collapsed[i]!.text);
    let j = i;
    while (j + 1 < collapsed.length && norm(collapsed[j + 1]!.text) === key) j += 1;
    const runLen = j - i + 1;
    if (runLen >= minRun) {
      out.push(collapsed[i]!); // keep the first segment of the looped run
    } else {
      for (let k = i; k <= j; k += 1) out.push(collapsed[k]!);
    }
    i = j + 1;
  }
  return out;
}

const THANK_YOU_RE = /^thank\s+you[\s.!,]*$/i;

export function filterHallucinations<T extends Segmentish>(segments: readonly T[]): T[] {
  // Pass 0: collapse decoder repetition loops (the same sentence emitted over
  // and over, within and across segments) down to a single instance, before
  // the phrase-based passes run.
  const deloop = collapseRepetitionLoops(segments);

  // Pass 1: drop the unconditional-noise phrases.
  const pass1 = deloop.filter((s) => !isWhisperNoise(s.text));

  // Pass 2: cluster-detect "thank you". A single one in a polite exchange
  // might be real; two or more is almost always whisper hallucinating on
  // silent chunks of the voice stem.
  const thankYouIndexes: number[] = [];
  pass1.forEach((s, i) => { if (THANK_YOU_RE.test(s.text.trim())) thankYouIndexes.push(i); });
  if (thankYouIndexes.length < 2) return pass1;
  const drop = new Set(thankYouIndexes);
  return pass1.filter((_, i) => !drop.has(i));
}
