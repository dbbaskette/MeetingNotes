import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const pExecFile = promisify(execFile);

export interface AudioSource {
  pid: number;
  bundleId: string | null;
  name: string | null;
  isMeetingApp: boolean;
  /** True iff CoreAudio reports this process is currently writing audio to
   *  an output device. Idle processes (registered audio session but not
   *  emitting) read as false. Attaching a Process Tap to an idle meeting
   *  app can hang its device negotiation when it later tries to go live
   *  (see issue #33) — surface this in the picker so users know which
   *  apps are safe to record right now. */
  isRunningOutput: boolean;
}

type Runner = (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

export class AppEnumerator {
  constructor(private readonly deps: { helperPath: string; runner?: Runner }) {}

  async list(): Promise<AudioSource[]> {
    const runner = this.deps.runner ?? ((c, a) => pExecFile(c, a, { timeout: 5000 }));
    const { stdout } = await runner(this.deps.helperPath, ['--list-audio-processes']);
    const line = stdout.split('\n').find((l) => l.includes('"event":"processes"'));
    if (!line) return [];
    const payload = JSON.parse(line) as {
      items?: { pid: number; bundle_id?: string; name?: string; is_meeting_app?: boolean; is_running_output?: boolean }[];
    };
    return (payload.items ?? []).map((it) => ({
      pid: it.pid,
      bundleId: it.bundle_id ?? null,
      name: it.name ?? null,
      isMeetingApp: it.is_meeting_app ?? false,
      // Default true when the helper doesn't emit the field (older binary):
      // better to show a live list than hide everything behind "idle" dimming.
      isRunningOutput: it.is_running_output ?? true,
    }));
  }
}
