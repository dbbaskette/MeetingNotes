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

/** Index of the line "active" at playback time `currentTime` — the line
 *  whose [start, nextStart) window covers the time. Binary search over
 *  the (sorted, ascending) line start times, so the per-tick highlight
 *  computation is O(log n) even for multi-thousand-line transcripts.
 *  Returns -1 when there are no lines or the time precedes the first. */
export function activeLineIndexAt(
  lines: readonly TranscriptLine[],
  currentTime: number,
): number {
  if (lines.length === 0) return -1;
  let lo = 0, hi = lines.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid]!.seconds <= currentTime) { best = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return best;
}

/** A run of consecutive same-speaker lines collapsed into one block.
 *  The merged view renders these instead of individual lines so a
 *  monologue reads as one paragraph rather than 30 timestamped
 *  fragments — but conversation flow is preserved because a switch in
 *  speaker (or a long silence, controlled by gapSeconds) ends the
 *  group and starts a new one. */
export interface TranscriptGroup {
  speaker: string;
  /** Start time of the first line in this group. Used for click-to-seek
   *  on the whole block. */
  startSeconds: number;
  /** Time of the last line's start — handy for showing a range. */
  endSeconds: number;
  /** Merged spoken text. Non-empty pieces joined with a space. */
  text: string;
  /** Indices into the original `TranscriptLine[]` that this group
   *  spans, in order. Lets the renderer keep its currentTime active
   *  highlight working — a group is active if its first..last index
   *  range covers the currently-active line. */
  lineIndices: number[];
}

// ────────────────────────────────────────────────────────────────────
// Export formatting
// ────────────────────────────────────────────────────────────────────

export type ExportFormat = 'md' | 'txt';
export type ExportViewMode = 'lines' | 'grouped';

export interface FormatTranscriptOpts {
  /** Meeting title for the document header. Empty → header skipped. */
  title?: string;
  /** ISO timestamp when the meeting started (for the header subline). */
  startedAt?: string | null;
  /** Match the active view in the renderer so the exported file
   *  reads the same way the user is seeing it. */
  viewMode: ExportViewMode;
  format: ExportFormat;
}

/** Render parsed transcript lines as a self-contained .md or .txt
 *  document. Both formats include speaker labels + timestamps; the
 *  difference is markdown styling (bold names, blockquote text vs.
 *  plain prose).
 *
 *  Pure function — no IO. Called from the renderer just before
 *  handing the string off to the file-save IPC. */
export function formatTranscriptForExport(
  lines: readonly TranscriptLine[],
  opts: FormatTranscriptOpts,
): string {
  const isMd = opts.format === 'md';
  const out: string[] = [];

  // Header
  if (opts.title) {
    out.push(isMd ? `# ${opts.title}` : opts.title);
    if (opts.startedAt) {
      const d = new Date(opts.startedAt);
      const human = isNaN(d.valueOf()) ? opts.startedAt : d.toLocaleString();
      out.push(isMd ? `_${human}_` : human);
    }
    out.push('');
  }

  if (opts.viewMode === 'lines') {
    // One row per timestamped line.
    for (const line of lines) {
      const ts = fmtTimestamp(line.seconds);
      if (isMd) {
        out.push(`**${line.speaker}** (${ts}): ${line.text}`);
      } else {
        out.push(`${line.speaker} [${ts}]: ${line.text}`);
      }
    }
  } else {
    // One block per consecutive same-speaker run. Groups read as
    // paragraphs of merged text — better for sharing/reading.
    const groups = groupConsecutiveBySpeaker(lines);
    for (const g of groups) {
      const startTs = fmtTimestamp(g.startSeconds);
      const range = g.endSeconds > g.startSeconds
        ? `${startTs} – ${fmtTimestamp(g.endSeconds)}`
        : startTs;
      if (isMd) {
        out.push(`**${g.speaker}** (${range})`);
        // Use a blockquote so multi-line groups stay visually grouped
        // when rendered. Each newline inside the merged text becomes
        // its own quoted line.
        for (const piece of g.text.split('\n')) {
          out.push(`> ${piece}`);
        }
      } else {
        out.push(`${g.speaker} (${range}):`);
        out.push(g.text);
      }
      out.push('');
    }
  }

  // Strip the final blank line that the grouped path emits, then add
  // a single trailing newline so editors don't fuss about no-newline-
  // at-end-of-file.
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out.join('\n') + '\n';
}

/** Collapse consecutive same-speaker lines into grouped blocks.
 *
 *  Two rules end a group and start the next one:
 *    1. Different speaker — preserves conversation flow.
 *    2. Time gap larger than `gapSeconds` between consecutive lines.
 *       Without this, a single speaker who pauses for 30s of silence
 *       (or the next speaker hasn't been diarized as such yet because
 *       of a brief mis-classification) would smush an entire meeting
 *       into one wall of text. 90s default is long enough that
 *       continuous speech doesn't fragment; short enough that the
 *       view stays scannable for meetings with long stretches of one
 *       speaker. */
export function groupConsecutiveBySpeaker(
  lines: readonly TranscriptLine[],
  opts: { gapSeconds?: number } = {},
): TranscriptGroup[] {
  const gap = opts.gapSeconds ?? 90;
  const groups: TranscriptGroup[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const last = groups[groups.length - 1];
    const continuesLast =
      last != null
      && last.speaker === line.speaker
      && line.seconds - last.endSeconds <= gap;
    if (continuesLast) {
      last.text = line.text ? `${last.text} ${line.text}`.trim() : last.text;
      last.endSeconds = line.seconds;
      last.lineIndices.push(i);
    } else {
      groups.push({
        speaker: line.speaker,
        startSeconds: line.seconds,
        endSeconds: line.seconds,
        text: line.text,
        lineIndices: [i],
      });
    }
  }
  return groups;
}
