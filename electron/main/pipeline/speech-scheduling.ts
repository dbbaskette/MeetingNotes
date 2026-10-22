/** Avoid overlapping native model working sets on long audio or low free RAM.
 * No chunked diarization: splitting would change cross-recording identities. */
export function sequentialSpeech(durationS: number | null, availableBytes: number): boolean {
  return durationS === null || durationS >= 3600 || availableBytes < 2 * 1024 ** 3;
}
