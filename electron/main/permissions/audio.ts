import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { systemPreferences } from 'electron';

const pExecFile = promisify(execFile);

export type PermissionState = 'granted' | 'denied' | 'not-determined' | 'unknown';
export interface AudioPermissions {
  mic: PermissionState;
  audioCapture: PermissionState;
}

type Runner = (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

/**
 * Triggers an OS-native microphone permission dialog (if not yet determined)
 * and returns whether microphone access is granted after the user responds.
 * Calling this is what causes MeetingNotes to appear in
 * System Settings → Privacy & Security → Microphone.
 */
export async function requestMicAccess(
  deps?: { askForMediaAccess?: (type: 'microphone') => Promise<boolean> },
): Promise<boolean> {
  const ask = deps?.askForMediaAccess ?? systemPreferences.askForMediaAccess.bind(systemPreferences);
  return ask('microphone');
}

/**
 * Returns the actual mic-access state for MeetingNotes itself
 * (not the helper subprocess). This is the source of truth for
 * "should we show the permissions modal" — Electron's
 * systemPreferences API queries TCC against the parent app's identity,
 * which is exactly what we want.
 */
export function getMicAccessStatus(
  deps?: { getMediaAccessStatus?: (type: 'microphone') => 'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown' },
): PermissionState {
  const get = deps?.getMediaAccessStatus
    ?? ((t: 'microphone') => systemPreferences.getMediaAccessStatus(t));
  const status = get('microphone');
  switch (status) {
    case 'granted': return 'granted';
    case 'denied': case 'restricted': return 'denied';
    case 'not-determined': return 'not-determined';
    default: return 'unknown';
  }
}

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
