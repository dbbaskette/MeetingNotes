// electron/main/speakers/sample-extractor.ts
//
// Extracts a short, representative audio clip for one diarized speaker so the
// UI can play "who is this voice?" when a user is tagging the roster. The
// input is the meeting's diarization.json (segments with start/end/speaker)
// plus audio.mp3; the output is a small mp3 cached under
// <meeting-folder>/samples/<localLabel>.mp3.
//
// Representative = the longest single segment where the speaker talks alone,
// capped at 8 seconds. Long monologues read better for identification than a
// quick back-and-forth; 8s is long enough to recognize a voice but short
// enough to click through 10 speakers without losing patience.
import fs from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const pExecFile = promisify(execFile);

export interface DiarizationSegment {
  start: number;
  end: number;
  speaker: string;
  embedding?: number[];
}

const MAX_CLIP_S = 8;
const MIN_CLIP_S = 1.5;

/** Pick the best [start,end] window (seconds) for a speaker's sample clip.
 *  Public for testability. */
export function pickSampleWindow(
  segments: readonly DiarizationSegment[],
  label: string,
): { start: number; end: number } | null {
  const own = segments.filter((s) => s.speaker === label && s.end - s.start >= MIN_CLIP_S);
  if (own.length === 0) return null;
  // Longest segment wins; if it's >MAX_CLIP_S, center the clip in it so we
  // don't always grab the (possibly noisy) very beginning.
  const longest = own.reduce((a, b) => (b.end - b.start > a.end - a.start ? b : a));
  const dur = longest.end - longest.start;
  if (dur <= MAX_CLIP_S) return { start: longest.start, end: longest.end };
  const mid = (longest.start + longest.end) / 2;
  return { start: mid - MAX_CLIP_S / 2, end: mid + MAX_CLIP_S / 2 };
}

type Runner = (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

export interface ExtractOpts {
  /** Absolute path to the meeting's audio file. */
  audioPath: string;
  /** Absolute path to diarization.json. */
  diarizationPath: string;
  /** Folder to write the cached clip into (created if missing). */
  sampleDir: string;
  /** Local diarizer label, e.g. "SPEAKER_03". */
  localLabel: string;
  /** Override ffmpeg runner for tests. */
  runner?: Runner;
}

export interface ExtractResult {
  path: string;
  startS: number;
  endS: number;
}

/** Extract (or return from cache) the sample clip for one speaker. */
export async function extractSpeakerSample(opts: ExtractOpts): Promise<ExtractResult | null> {
  const runner: Runner = opts.runner ?? ((c, a) => pExecFile(c, a, { timeout: 20000 }));
  const out = path.join(opts.sampleDir, `${safeLabel(opts.localLabel)}.mp3`);

  const diar = JSON.parse(await fs.readFile(opts.diarizationPath, 'utf8')) as {
    segments: DiarizationSegment[];
  };
  const win = pickSampleWindow(diar.segments, opts.localLabel);
  if (!win) return null;

  if (!existsSync(opts.sampleDir)) mkdirSync(opts.sampleDir, { recursive: true });

  // Cache hit: we store the window boundaries in a sidecar .json so we can
  // invalidate the clip when diarization changes (rerun would rewrite
  // diarization.json with different boundaries and we don't want stale audio).
  const metaPath = `${out}.json`;
  if (existsSync(out) && existsSync(metaPath)) {
    try {
      const cached = JSON.parse(await fs.readFile(metaPath, 'utf8')) as ExtractResult;
      if (Math.abs(cached.startS - win.start) < 0.01 && Math.abs(cached.endS - win.end) < 0.01) {
        return cached;
      }
    } catch { /* fall through and re-extract */ }
  }

  // -ss before -i is fast-seek; good enough for sample clips. -c:a libmp3lame
  // (re-encode) rather than stream-copy so the output is always a clean mp3
  // regardless of input container/codec (could be m4a, wav, etc.).
  await runner('ffmpeg', [
    '-y',
    '-ss', win.start.toFixed(3),
    '-to', win.end.toFixed(3),
    '-i', opts.audioPath,
    '-ac', '1',
    '-ar', '22050',
    '-b:a', '64k',
    '-codec:a', 'libmp3lame',
    out,
  ]);

  const result: ExtractResult = { path: out, startS: win.start, endS: win.end };
  await fs.writeFile(metaPath, JSON.stringify(result));
  return result;
}

/** Average embedding vector for a local label — used to confirm a speaker
 *  into the roster from the UI without the renderer needing to see embeddings. */
export function averageEmbeddingForLabel(
  segments: readonly DiarizationSegment[],
  label: string,
): number[] | null {
  const own = segments.filter((s) => s.speaker === label && Array.isArray(s.embedding));
  if (own.length === 0) return null;
  const dim = own[0]!.embedding!.length;
  const sum = new Array<number>(dim).fill(0);
  for (const s of own) {
    for (let i = 0; i < dim; i++) sum[i] = (sum[i] ?? 0) + (s.embedding![i] ?? 0);
  }
  return sum.map((x) => x / own.length);
}

function safeLabel(label: string): string {
  return label.replace(/[^A-Za-z0-9_.-]/g, '_');
}
