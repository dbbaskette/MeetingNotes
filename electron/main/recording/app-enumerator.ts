import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const pExecFile = promisify(execFile);

export interface AudioSource {
  pid: number;
  bundleId: string | null;
  name: string | null;
  isMeetingApp: boolean;
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
      items?: { pid: number; bundle_id?: string; name?: string; is_meeting_app?: boolean }[];
    };
    return (payload.items ?? []).map((it) => ({
      pid: it.pid,
      bundleId: it.bundle_id ?? null,
      name: it.name ?? null,
      isMeetingApp: it.is_meeting_app ?? false,
    }));
  }
}
