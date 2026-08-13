/**
 * Responsive layout contract for the compact speaker-review rail. The rail
 * is only 240px wide on desktop, so the identity details must be allowed to
 * shrink while review badges wrap below them instead of squeezing the text
 * column into one character per line.
 */
export function speakerReviewLayout(): {
  button: string;
  details: string;
  status: string;
} {
  return {
    button: 'flex-1 min-w-0 flex items-start gap-2 p-2 text-left',
    details: 'flex-1 min-w-0',
    status: 'mt-1 flex flex-wrap items-center gap-1.5',
  };
}
