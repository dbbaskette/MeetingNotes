import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ffprobePath } from '../lib/find-ffmpeg.js';

const pExecFile = promisify(execFile);
type Runner = (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

export interface AudioInfo { durationS: number; }

export async function probeAudio(file: string, deps: { runner?: Runner } = {}): Promise<AudioInfo> {
  const runner: Runner = deps.runner ?? ((c, a) => pExecFile(c, a, { timeout: 10000 }));
  const { stdout, stderr } = await runner(ffprobePath(), [
    '-v', 'error', '-print_format', 'json', '-show_format', file,
  ]);
  if (stderr.trim() || !stdout.trim()) throw new Error(`ffprobe: invalid or empty file: ${stderr.trim()}`);
  const parsed = JSON.parse(stdout) as { format?: { duration?: string } };
  const dur = parsed.format?.duration;
  if (!dur) throw new Error('ffprobe: no duration');
  return { durationS: Number(dur) };
}
