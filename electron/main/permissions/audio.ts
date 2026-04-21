import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const pExecFile = promisify(execFile);

export type PermissionState = 'granted' | 'denied' | 'not-determined' | 'unknown';
export interface AudioPermissions {
  mic: PermissionState;
  audioCapture: PermissionState;
}

type Runner = (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

/**
 * Asks the bundled helper to report mic + audio-capture TCC state. The
 * helper's audio-capture probe is best-effort (Apple does not expose a
 * stable API for "would CoreAudio Process Tap succeed"); a 'not-determined'
 * or 'unknown' result means we should let the user try recording and surface
 * a clearer error from there.
 */
export async function probeAudioPermissions(
  deps: { helperPath: string; runner?: Runner },
): Promise<AudioPermissions> {
  const runner = deps.runner ?? ((c, a) => pExecFile(c, a, { timeout: 5000 }));
  try {
    const { stdout } = await runner(deps.helperPath, ['--probe-permissions']);
    const line = stdout.split('\n').find((l) => l.includes('"event":"permissions"'));
    if (!line) return { mic: 'unknown', audioCapture: 'unknown' };
    const p = JSON.parse(line) as { mic?: string; audio_capture?: string };
    return {
      mic: (p.mic as PermissionState) ?? 'unknown',
      audioCapture: (p.audio_capture as PermissionState) ?? 'unknown',
    };
  } catch {
    return { mic: 'unknown', audioCapture: 'unknown' };
  }
}
