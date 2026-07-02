import path from 'node:path';

/**
 * Pure path derivations for the consolidated storage layout (Option B).
 *
 * User-facing data (recordings, meetings, db.sqlite) lives under a single
 * Library root; re-downloadable / derived data (whisper models, logs) stays
 * in the conventional macOS locations so GBs don't end up in iCloud; the
 * HF/pyannote cache is left where the Hugging Face library demands it.
 *
 * No I/O here — these are just string joins so they can be unit-tested and
 * reused from both the main process and (indirectly) the renderer.
 */

/** Recordings now live *inside* the library root, so relocating the library
 *  moves recordings with it. Derived, not a separate setting. */
export function recordingsDirFor(libraryRoot: string): string {
  return path.join(libraryRoot, 'recordings');
}

/**
 * The set of folders the library watcher observes for freshly-arrived audio.
 *
 * Order/back-compat:
 *  1. `<library>/recordings` — where the built-in recorder now writes.
 *  2. `~/Music/MeetingNotes` — the legacy recorder location; always watched so
 *     files dropped there during/after the transition are still cataloged.
 *  3. `~/Music/Audio Hijack` — legacy Audio Hijack drops; always watched.
 *  4. `audioWatchPath` — an OPTIONAL extra drop folder, appended only when set.
 *
 * The result is deduped (so an audioWatchPath equal to a legacy path collapses)
 * and drops empty/blank entries.
 */
export function libraryWatchPaths(opts: {
  libraryRoot: string;
  audioWatchPath: string;
  home: string;
}): string[] {
  const { libraryRoot, audioWatchPath, home } = opts;
  const candidates = [
    recordingsDirFor(libraryRoot),
    path.join(home, 'Music', 'MeetingNotes'),
    path.join(home, 'Music', 'Audio Hijack'),
    ...(audioWatchPath.trim() ? [audioWatchPath] : []),
  ];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of candidates) {
    if (!p) continue;
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

export type StorageLocationKey = 'library' | 'models' | 'logs' | 'hfCache';

export interface StorageLocation {
  key: StorageLocationKey;
  label: string;
  path: string;
  note: string;
}

/** The legible storage map surfaced in Settings → Storage. Each row gets a
 *  Reveal-in-Finder button and a one-line rationale. */
export function storageLocations(opts: {
  libraryRoot: string;
  home: string;
}): StorageLocation[] {
  const { libraryRoot, home } = opts;
  return [
    {
      key: 'library',
      label: 'Library',
      path: libraryRoot,
      note: 'Recordings, meetings, and the database.',
    },
    {
      key: 'models',
      label: 'Models',
      path: path.join(home, 'Library', 'Application Support', 'MeetingNotes', 'whisper-models'),
      note: 'Whisper models — re-downloadable, kept out of iCloud.',
    },
    {
      key: 'logs',
      label: 'Logs',
      path: path.join(home, 'Library', 'Logs', 'MeetingNotes'),
      note: 'App logs.',
    },
    {
      key: 'hfCache',
      label: 'AI model cache',
      path: path.join(home, '.cache', 'huggingface'),
      note: 'Diarization models + token — shared with other Hugging Face tools.',
    },
  ];
}
