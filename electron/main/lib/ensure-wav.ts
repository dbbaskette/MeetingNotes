import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, basename, extname } from 'node:path';
import { mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

// Detect once whether this ffmpeg build links libsoxr. Homebrew's default
// ffmpeg does NOT ship soxr; anyone who needs the very best downsample
// installs it explicitly. The lookup is cached because it's a ~50ms shell
// probe and we run ensureWav once per transcribe.
let _soxrSupport: boolean | null = null;
function ffmpegHasSoxr(): boolean {
  if (_soxrSupport !== null) return _soxrSupport;
  try {
    // Try a tiny null-source transcode with soxr. If the binary lacks soxr,
    // ffmpeg prints "Requested resampling engine is unavailable" and exits
    // non-zero. 1s of silence is enough; the pipe never hits disk.
    const r = spawnSync('ffmpeg', [
      '-v', 'error',
      '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono',
      '-af', 'aresample=resampler=soxr:precision=28',
      '-t', '0.01', '-f', 'null', '-',
    ]);
    _soxrSupport = r.status === 0;
  } catch {
    _soxrSupport = false;
  }
  return _soxrSupport;
}

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
    //
    // Resampler quality: Whisper WER is sensitive to aliasing artifacts on
    // the 48 kHz → 16 kHz downsample, especially on sibilants and
    // high-frequency consonants. If this ffmpeg has libsoxr, use it at
    // 28-bit precision — effectively transparent. Otherwise fall back to
    // the built-in swr resampler with a much larger filter_size than the
    // default 32 taps, which gets us most of the way there on the
    // stock homebrew build. Either path is cheap next to the Whisper run.
    const filter = ffmpegHasSoxr()
      ? 'aresample=resampler=soxr:precision=28'
      : 'aresample=resampler=swr:filter_size=256:phase_shift=14:dither_method=triangular_hp';
    const proc = spawn('ffmpeg', [
      '-y', '-loglevel', 'error',
      '-i', audioPath,
      '-af', filter,
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
