// Speaker colors come from CSS custom properties in index.css so they follow
// the light/dark palette and are checked for WCAG AA in appearance.test.ts.
// The raw hex palette that used to live here failed AA both under white
// initials and as text on app surfaces (#296).
export const SPEAKER_COLOR_COUNT = 6;

function slot(idx: number): number {
  return (((idx % SPEAKER_COLOR_COUNT) + SPEAKER_COLOR_COUNT) % SPEAKER_COLOR_COUNT) + 1;
}

/** Background for a speaker avatar; pair it with white text. */
export function speakerFill(idx: number): string {
  return `rgb(var(--speaker-${slot(idx)}))`;
}

/** The same hue as foreground text on an app surface, in either appearance. */
export function speakerText(idx: number): string {
  return `rgb(var(--speaker-${slot(idx)}-text))`;
}

/** @deprecated Use speakerText / speakerFill. Kept only because the epic243
 *  renderer fixture benchmarks a pinned old copy of MeetingTranscriptPanel
 *  (git show 1be1704) that imports this name. */
export const colorForSpeakerIndex = speakerText;
