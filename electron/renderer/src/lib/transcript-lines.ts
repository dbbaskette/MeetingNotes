// electron/renderer/src/lib/transcript-lines.ts
//
// Parse the merge-transcript output format — lines look like
//   [Speaker name MM:SS] spoken text
// or with multi-word names + hour-length meetings:
//   [Alice Smith H:MM:SS] spoken text
// — into structured records the transcript viewer can use for click-to-
// seek + currently-playing highlight (#42).

export interface TranscriptLine {
  raw: string;
  /** Speaker label as rendered (already mapped through labelMap upstream). */
  speaker: string;
  /** Line-start time in seconds, for click-to-seek. */
  seconds: number;
  /** The spoken text, with the timestamp prefix stripped. */
  text: string;
}

export interface TranscriptBlock {
  /** Lines that match the `[Speaker MM:SS] text` shape and are seekable. */
  lines: TranscriptLine[];
  /** True if any line is missing the timestamp prefix — in which case
   *  the UI renders the full transcriptMd as plain text without
   *  click-to-seek. (Raw pre-merge transcripts have no timestamps.) */
  hasUnparsed: boolean;
}

// Anchored regex so speaker-bracket-looking things inside the body text
// don't accidentally match. `[name …HH:]MM:SS]` — the hour group is
// optional. `.+?` for the name handles multi-word names like "Alice Smith".
const LINE_RE = /^\[(.+?)\s+(?:(\d+):)?(\d+):(\d{2})\]\s?(.*)$/;

/** Parse a merged transcript into a list of seekable lines. Returns
 *  `hasUnparsed: true` if any non-empty line didn't match the timestamp
 *  format, so the caller can fall back to raw-text rendering. */
export function parseTranscript(transcript: string): TranscriptBlock {
  const lines: TranscriptLine[] = [];
  let hasUnparsed = false;
  for (const raw of transcript.split('\n')) {
    if (raw.trim() === '') continue; // swallow blank separators
    const m = raw.match(LINE_RE);
    if (!m) { hasUnparsed = true; continue; }
    const [, speaker, hhStr, mm, ss, text] = m;
    const hh = hhStr ? parseInt(hhStr, 10) : 0;
    lines.push({
      raw,
      speaker: speaker!,
      seconds: hh * 3600 + parseInt(mm!, 10) * 60 + parseInt(ss!, 10),
      text: text ?? '',
    });
  }
  return { lines, hasUnparsed };
}

/** Format MM:SS or H:MM:SS for display next to a line. Matches the format
 *  used in transcript.md so click-to-seek UI labels stay self-describing. */
export function fmtTimestamp(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const mm = m.toString().padStart(2, '0');
  const ss = s.toString().padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
