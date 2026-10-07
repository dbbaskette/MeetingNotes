// electron/main/lib/title-from-filename.ts
//
// Parse a recording filename into { autoTitle, startedAtIso }.
// Handles three on-disk formats:
//
//   1. Audio Hijack:           "<title> YYYY-MM-DD HH.MM.{m4a,mp3}"
//      e.g. "Q2 Planning 2026-04-17 09.05.mp3"
//
//   2. Built-in recorder:      "recording-YYYYMMDD-HHMMSS-<id>.m4a"
//      e.g. "recording-20260417-090517-bfcb369a.m4a"
//
//   3. "<title> YYYYMMDD HHMM" (no separators between digits) —
//      common from Zoom / Discord voice-chat exports and several
//      meeting recorder defaults.
//      e.g. "Voice Chat 20260410 1200.mp3"
//
// Return UTC instants: external filename wall clocks are interpreted locally;
// built-in filenames encode UTC (RecordingManager uses toISOString).
//
// `parseAudioHijackFilename` is the legacy export retained for
// backward compatibility with callers + tests. Prefer the new
// `parseRecordingFilename` going forward — same shape, all
// formats supported.

import path from 'node:path';
import { meetingInstant } from './meeting-instant.js';

const AH_REGEX = /^(.+?)\s+(\d{4}-\d{2}-\d{2})\s+(\d{2})\.(\d{2})$/;
const BUILTIN_REGEX = /^recording-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})(?:-[A-Za-z0-9]+)?$/;
// "Title YYYYMMDD HHMM" — eight-digit date + four-digit time, both
// with no internal separators, separated from the title by whitespace.
const COMPACT_DT_REGEX = /^(.+?)\s+(\d{4})(\d{2})(\d{2})\s+(\d{2})(\d{2})$/;

export interface ParsedFilename {
  /** Title to show in the library before the user (or summarizer)
   *  renames it. Falls back to the basename without extension. */
  autoTitle: string;
  /** UTC ISO instant, or null for an unknown/invalid filename clock. */
  startedAtIso: string | null;
}

export function parseRecordingFilename(filename: string): ParsedFilename {
  const base = path.basename(filename).replace(/\.[^.]+$/, '');

  // Audio Hijack first (more specific — has free-form title).
  const ah = base.match(AH_REGEX);
  if (ah) {
    const [, title, date, hh, mm] = ah;
    return {
      autoTitle: title!.trim(),
      startedAtIso: meetingInstant(`${date}T${hh}:${mm}:00`, filename),
    };
  }

  // Built-in recorder.
  const bi = base.match(BUILTIN_REGEX);
  if (bi) {
    const [, y, mo, d, hh, mm, ss] = bi;
    return {
      // No human-readable title in the built-in format — keep the
      // basename so the user can recognize the row before the
      // summarizer auto-titles it.
      autoTitle: base,
      startedAtIso: meetingInstant(`${y}-${mo}-${d}T${hh}:${mm}:${ss}`, filename),
    };
  }

  // Compact-datetime ("Voice Chat YYYYMMDD HHMM") — Zoom + Discord
  // export under names of this shape; treat the prefix as the title.
  const cd = base.match(COMPACT_DT_REGEX);
  if (cd) {
    const [, title, y, mo, d, hh, mm] = cd;
    return {
      autoTitle: title!.trim(),
      startedAtIso: meetingInstant(`${y}-${mo}-${d}T${hh}:${mm}:00`, filename),
    };
  }

  return { autoTitle: base, startedAtIso: null };
}

/** @deprecated Use parseRecordingFilename — same shape, also handles
 *  the built-in recorder format. Kept for legacy import paths. */
export const parseAudioHijackFilename = parseRecordingFilename;
