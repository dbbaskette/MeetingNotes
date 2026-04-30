// electron/main/lib/chunk-wav.ts
//
// Splits long WAV files into smaller pieces so the HTTP upload to
// whisper-server stays under its built-in body-size limit. Long
// meetings (>~70 min) at 16 kHz mono 16-bit produce WAVs that exceed
// whisper.cpp 1.8.x's ~128 MB cap and come back as HTTP 413.
//
// Strategy: fixed-time slices with no overlap. Whisper has its own
// internal segmentation, so each chunk is transcribed independently
// and we add the chunk's start offset to every segment's
// start/end before stitching the segments together.
//
// We deliberately don't try silence-aware splitting — `ffmpeg
// silencedetect` is slow on long files and the ~1-2 second loss at
// each chunk boundary on a 70+ min meeting is acceptable. If it ever
// becomes a problem we can add a small overlap window and dedupe at
// the seam.
//
// The chunked path costs an extra ffmpeg pass (~5-10s for a 70 min
// WAV with `-c copy`); it only kicks in when the source exceeds the
// size threshold, so short meetings pay nothing.

import { spawn, execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { mkdirSync, statSync, existsSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { ffmpegPath, ffprobePath } from './find-ffmpeg.js';

const pExecFile = promisify(execFile);

/** Size at or below which we send the WAV in a single request. Chosen
 *  to leave headroom under whisper.cpp 1.8.x's hardcoded ~128 MB body
 *  limit; smaller is fine, much smaller wastes time chunking files
 *  whisper-server would have accepted in one shot. */
export const CHUNK_SIZE_THRESHOLD = 100 * 1024 * 1024; // 100 MB

/** Default chunk length. 25 min × 32 KB/s (16 kHz mono s16) = 48 MB
 *  per chunk — well under the threshold and big enough that whisper
 *  hits its full attention window inside each chunk. */
export const DEFAULT_CHUNK_DURATION_S = 25 * 60;

export interface WavChunk {
  /** Path to a WAV file containing this chunk's audio. */
  path: string;
  /** Offset of the chunk's first sample within the original WAV, in
   *  seconds. Add this to every transcript segment's start/end before
   *  merging chunks. 0 for the first chunk. */
  startS: number;
  /** Drops the chunk's temp file. No-op for the original-file
   *  passthrough case. */
  cleanup: () => void;
}

async function probeDurationS(wavPath: string): Promise<number> {
  const { stdout } = await pExecFile(
    ffprobePath(),
    ['-v', 'error', '-print_format', 'json', '-show_format', wavPath],
    { timeout: 10_000 },
  );
  const parsed = JSON.parse(stdout) as { format?: { duration?: string } };
  const dur = Number(parsed.format?.duration);
  if (!Number.isFinite(dur) || dur <= 0) {
    throw new Error(`chunk-wav: ffprobe returned no usable duration for ${wavPath}`);
  }
  return dur;
}

/** Returns the WAV in one piece if it fits under CHUNK_SIZE_THRESHOLD,
 *  otherwise splits it into ~chunkDurationS-second slices.
 *
 *  Each chunk's `cleanup()` deletes its temp file. The single-piece
 *  passthrough path returns a no-op cleanup so callers can treat
 *  both cases uniformly. */
export async function chunkWavIfNeeded(
  wavPath: string,
  chunkDurationS: number = DEFAULT_CHUNK_DURATION_S,
): Promise<WavChunk[]> {
  const size = statSync(wavPath).size;
  if (size <= CHUNK_SIZE_THRESHOLD) {
    return [{ path: wavPath, startS: 0, cleanup: () => { /* no-op */ } }];
  }

  const totalDuration = await probeDurationS(wavPath);
  const numChunks = Math.ceil(totalDuration / chunkDurationS);

  const tmpRoot = join(tmpdir(), 'meetingnotes-wav-chunks');
  mkdirSync(tmpRoot, { recursive: true });

  const chunks: WavChunk[] = [];
  const baseId = randomUUID().slice(0, 8);
  const stem = basename(wavPath, '.wav');

  for (let i = 0; i < numChunks; i++) {
    const startS = i * chunkDurationS;
    const outPath = join(tmpRoot, `${stem}-chunk${i}-${baseId}.wav`);

    // -ss before -i is fast-seek; combined with -c copy this is a
    // near-instant lossless slice (no re-encode). The last chunk's -t
    // overshoots the file end harmlessly — ffmpeg stops at EOF.
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(ffmpegPath(), [
        '-y', '-loglevel', 'error',
        '-ss', String(startS),
        '-t', String(chunkDurationS),
        '-i', wavPath,
        '-c', 'copy',
        outPath,
      ]);
      let stderr = '';
      proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
      proc.on('error', reject);
      proc.on('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg chunk exit ${code}: ${stderr.slice(0, 500)}`));
      });
    });

    chunks.push({
      path: outPath,
      startS,
      cleanup: () => {
        try {
          if (existsSync(outPath)) unlinkSync(outPath);
        } catch { /* best-effort; tmpdir is cleaned by the OS eventually */ }
      },
    });
  }

  return chunks;
}
