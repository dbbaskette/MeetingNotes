// electron/renderer/src/lib/speaker-colors.ts
//
// Stable speaker → palette-index assignment for the transcript view
// (#A4). Indices are handed out in order of FIRST APPEARANCE in the
// transcript lines — not meeting.speakers order — so a speaker keeps
// the same color for the whole transcript regardless of how the
// speakers rail happens to sort them, and the mapping is deterministic
// for a given transcript. The index feeds the same palette the speaker
// avatars use (theme/tokens colorForSpeakerIndex).

/** Map each distinct speaker label to a palette index, in order of
 *  first appearance. Pure — safe to memoize on the parsed lines. */
export function speakerColorIndex(
  lines: readonly { speaker: string }[],
): Map<string, number> {
  const map = new Map<string, number>();
  for (const { speaker } of lines) {
    if (!map.has(speaker)) map.set(speaker, map.size);
  }
  return map;
}
