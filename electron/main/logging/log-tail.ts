// electron/main/logging/log-tail.ts
//
// Bounded reader for the JSON-lines app.log, powering the in-app
// Diagnostics view. We never read the whole file — a long-running install
// accumulates megabytes — so we read at most the trailing `maxBytes` and
// parse from there. Lines are tolerant: a well-formed `{ts,level,msg,...}`
// object becomes a structured entry; anything else (a partial first line
// from the byte-bounded read, or a stray non-JSON write) is surfaced as a
// plain info line rather than dropped, so the user never silently loses log
// content.

import fs from 'node:fs';

export interface LogEntry {
  /** ISO timestamp, or null for lines that didn't carry one. */
  ts: string | null;
  level: string;
  msg: string;
  /** Any extra structured fields beyond ts/level/msg. Omitted when empty. */
  data?: Record<string, unknown>;
}

/** Parse JSON-lines log text into entries, oldest-first, capped to the most
 *  recent `maxEntries`. `dropFirstLine` discards the leading (likely
 *  partial) line — set it when the text came from a mid-file byte read. */
export function parseLogLines(
  text: string,
  maxEntries: number,
  dropFirstLine = false,
): LogEntry[] {
  let lines = text.split('\n');
  if (dropFirstLine && lines.length > 0) lines = lines.slice(1);

  const entries: LogEntry[] = [];
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.length === 0) continue;
    entries.push(parseOne(line));
  }
  // Keep only the newest maxEntries (the tail of the chronological list).
  return maxEntries > 0 && entries.length > maxEntries
    ? entries.slice(entries.length - maxEntries)
    : entries;
}

function parseOne(line: string): LogEntry {
  try {
    const obj = JSON.parse(line) as Record<string, unknown>;
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      const { ts, level, msg, ...rest } = obj;
      const data =
        Object.keys(rest).length > 0
          ? (rest as Record<string, unknown>)
          : undefined;
      return {
        ts: typeof ts === 'string' ? ts : null,
        level: typeof level === 'string' ? level : 'info',
        msg: typeof msg === 'string' ? msg : line,
        ...(data ? { data } : {}),
      };
    }
  } catch {
    /* not JSON — fall through to plain line */
  }
  return { ts: null, level: 'info', msg: line };
}

export interface TailOptions {
  /** Max bytes to read from the end of the file. Default 256 KiB. */
  maxBytes?: number;
  /** Max entries to return (newest). Default 500. */
  maxEntries?: number;
}

/** Read the tail of a JSON-lines log file and return parsed entries,
 *  oldest-first. Returns [] if the file doesn't exist yet. */
export function tailLogFile(filePath: string, opts: TailOptions = {}): LogEntry[] {
  const maxBytes = opts.maxBytes ?? 256 * 1024;
  const maxEntries = opts.maxEntries ?? 500;

  let fd: number;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch {
    return []; // no log yet
  }
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    if (length === 0) return [];
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, start);
    // If we started mid-file, the first line is probably a fragment.
    return parseLogLines(buf.toString('utf8'), maxEntries, start > 0);
  } finally {
    fs.closeSync(fd);
  }
}
