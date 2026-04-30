// electron/main/lib/find-ffmpeg.ts
//
// Resolve absolute paths for ffmpeg and ffprobe. Electron apps
// launched from Finder / Dock inherit a minimal PATH that excludes
// /opt/homebrew/bin (Apple Silicon) and /usr/local/bin (Intel).
// Bare `spawn('ffmpeg', …)` works in `npm run dev` (shell PATH)
// but fails with ENOENT in the packaged .dmg.
//
// We search the same well-known locations the whisper and LLM
// supervisors already use, cache the result, and export a pair of
// strings the rest of the codebase can pass to spawn / execFile.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const SEARCH_PATHS = [
  '/opt/homebrew/bin',       // Apple Silicon Homebrew
  '/usr/local/bin',          // Intel Homebrew / manual installs
  '/opt/homebrew/opt/ffmpeg/bin', // Homebrew keg-only fallback
  '/usr/local/opt/ffmpeg/bin',
];

function findBinary(name: string): string {
  // 1. Try PATH (works in dev, rarely in packaged app)
  try {
    const out = execFileSync('which', [name], { encoding: 'utf8' }).trim();
    if (out) return out;
  } catch { /* fall through */ }

  // 2. Well-known Homebrew / system locations
  for (const dir of SEARCH_PATHS) {
    const p = `${dir}/${name}`;
    if (fs.existsSync(p)) return p;
  }

  throw new Error(
    `${name} not found. Install with: brew install ffmpeg`,
  );
}

let _ffmpeg: string | null = null;
let _ffprobe: string | null = null;

/** Absolute path to ffmpeg. Cached after first call. */
export function ffmpegPath(): string {
  if (!_ffmpeg) _ffmpeg = findBinary('ffmpeg');
  return _ffmpeg;
}

/** Absolute path to ffprobe. Cached after first call. */
export function ffprobePath(): string {
  if (!_ffprobe) _ffprobe = findBinary('ffprobe');
  return _ffprobe;
}
