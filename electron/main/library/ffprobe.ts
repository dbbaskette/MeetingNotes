import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ffprobePath } from '../lib/find-ffmpeg.js';

const pExecFile = promisify(execFile);
type Runner = (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

export interface AudioInfo { durationS: number; }
export class InvalidAudioError extends Error {}

export async function probeAudio(file: string, deps: { runner?: Runner } = {}): Promise<AudioInfo> {
  const runner: Runner = deps.runner ?? ((c, a) => pExecFile(c, a, { timeout: 10000 }));
  let stdout: string, stderr: string;
  try {
    ({ stdout, stderr } = await runner(ffprobePath(), [
      '-v', 'error', '-print_format', 'json', '-show_format', file,
    ]));
  } catch (error) {
    const details = error as { stderr?: unknown; code?: unknown; killed?: boolean };
    // A failed launch, permission denial, timeout, or resource failure must
    // remain retryable. Only a completed decoder rejection proves bad media.
    if (typeof details.code === 'number' && !details.killed && typeof details.stderr === 'string'
      && /moov atom not found|invalid data found when processing input/i.test(details.stderr)) {
      throw new InvalidAudioError(`ffprobe: invalid media: ${details.stderr.trim()}`);
    }
    throw error;
  }
  if (stderr.trim() || !stdout.trim()) throw new Error(`ffprobe: invalid or empty file: ${stderr.trim()}`);
  const parsed = JSON.parse(stdout) as { format?: { duration?: string } };
  const dur = parsed.format?.duration;
  if (!dur || !Number.isFinite(Number(dur)) || Number(dur) <= 0) throw new InvalidAudioError('ffprobe: no usable duration');
  return { durationS: Number(dur) };
}
