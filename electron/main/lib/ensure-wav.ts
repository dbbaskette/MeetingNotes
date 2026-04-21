import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, basename, extname } from 'node:path';
import { mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

export interface EnsuredWav {
  path: string;
  cleanup: () => void;
}

/**
 * Returns a path to a 16kHz mono 16-bit PCM WAV version of the given audio
 * file. If the input is already (heuristically) WAV, returns it unchanged
 * with a no-op cleanup. Otherwise shells out to ffmpeg to produce a temp
 * file and returns a cleanup callback the caller invokes when done.
 *
 * Why: whisper-server and pyannote.audio both have flaky support for
 * m4a/AAC inputs. Pre-transcoding to PCM WAV is the most universal
 * format and bypasses all codec compatibility issues.
 */
export async function ensureWav(audioPath: string): Promise<EnsuredWav> {
  if (extname(audioPath).toLowerCase() === '.wav') {
    return { path: audioPath, cleanup: () => { /* no-op */ } };
  }

  const tmpRoot = join(tmpdir(), 'meetingnotes-wav');
  mkdirSync(tmpRoot, { recursive: true });
  const outPath = join(tmpRoot, `${basename(audioPath, extname(audioPath))}-${randomUUID().slice(0, 8)}.wav`);

  await new Promise<void>((resolve, reject) => {
    // -ac 1: mono. -ar 16000: 16 kHz. -sample_fmt s16: 16-bit signed PCM.
    // -y: overwrite without prompting. -loglevel error: stay quiet on stderr.
    // Whisper.cpp wants exactly this format; pyannote handles it natively.
    const proc = spawn('ffmpeg', [
      '-y', '-loglevel', 'error',
      '-i', audioPath,
      '-ac', '1', '-ar', '16000', '-sample_fmt', 's16',
      outPath,
    ]);
    let stderr = '';
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(0, 500)}`));
    });
  });

  return {
    path: outPath,
    cleanup: () => {
      try {
        if (existsSync(outPath)) unlinkSync(outPath);
      } catch {
        // best-effort; the OS will GC tmpdir eventually
      }
    },
  };
}
