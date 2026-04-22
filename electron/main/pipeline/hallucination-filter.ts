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

const THANK_YOU_RE = /^thank\s+you[\s.!,]*$/i;

export function filterHallucinations<T extends Segmentish>(segments: readonly T[]): T[] {
  // Pass 1: drop the unconditional-noise phrases.
  const pass1 = segments.filter((s) => !isWhisperNoise(s.text));

  // Pass 2: cluster-detect "thank you". A single one in a polite exchange
  // might be real; two or more is almost always whisper hallucinating on
  // silent chunks of the voice stem.
  const thankYouIndexes: number[] = [];
  pass1.forEach((s, i) => { if (THANK_YOU_RE.test(s.text.trim())) thankYouIndexes.push(i); });
  if (thankYouIndexes.length < 2) return pass1;
  const drop = new Set(thankYouIndexes);
  return pass1.filter((_, i) => !drop.has(i));
}
