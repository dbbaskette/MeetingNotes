// electron/main/lib/stem-paths.ts
//
// Helpers for the dual-stem capture files (#13 Phase 1). A recording's
// primary output is `foo.m4a` (mixed mic + tap); sidecar stems are
// `foo.voice.m4a` (mic only) and `foo.system.m4a` (tap only). The
// recovery/trash paths retain these names. Processing intentionally uses
// the primary mixed timeline for both STT and diarization (#173).

import fs from 'node:fs';
import path from 'node:path';

export interface StemPaths {
  voice: string;
  system: string;
}

/**
 * Given the path to a mixed recording, return the paths the Swift helper
 * *would* have written its stems to (whether they exist or not).
 * Purely derivational — no disk access.
 */
export function deriveStemPaths(mixedPath: string): StemPaths {
  const ext = path.extname(mixedPath); // ".m4a" / ".mp3" / ""
  const base = ext ? mixedPath.slice(0, -ext.length) : mixedPath;
  return {
    voice: `${base}.voice${ext}`,
    system: `${base}.system${ext}`,
  };
}

/** True iff both stem files exist on disk alongside the mixed file. */
export function hasStems(mixedPath: string): boolean {
  const { voice, system } = deriveStemPaths(mixedPath);
  return fs.existsSync(voice) && fs.existsSync(system);
}

/** Synthetic speaker label assigned to segments coming from the voice
 *  (mic) stem. Rendered via the meeting's labelMap → user's name. */
export const VOICE_SPEAKER_LABEL = 'VOICE_YOU';
