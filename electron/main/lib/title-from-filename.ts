import path from 'node:path';

const AH_REGEX = /^(.+?)\s+(\d{4}-\d{2}-\d{2})\s+(\d{2})\.(\d{2})$/;

export interface ParsedFilename {
  autoTitle: string;
  startedAtIso: string | null;
}

export function parseAudioHijackFilename(filename: string): ParsedFilename {
  const base = path.basename(filename).replace(/\.[^.]+$/, '');
  const m = base.match(AH_REGEX);
  if (!m) return { autoTitle: base, startedAtIso: null };
  const [, title, date, hh, mm] = m;
  return { autoTitle: title!.trim(), startedAtIso: `${date}T${hh}:${mm}:00` };
}
