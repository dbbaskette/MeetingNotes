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
  /** True when the helper resolved this process to a Dock-visible app by
   *  walking the parent chain (Chrome/Zoom helpers → their app). False for
   *  system daemons — the picker tucks those behind a disclosure. */
  isUserApp: boolean;
  /** Dock-visible app this audio process belongs to (falls back to the
   *  process's own identity when the helper predates these fields). */
  ownerPid: number;
  ownerName: string | null;
  ownerBundleId: string | null;
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
      items?: {
        pid: number; bundle_id?: string; name?: string; is_meeting_app?: boolean;
        is_running_output?: boolean; is_user_app?: boolean; owner_pid?: number; owner_name?: string; owner_bundle_id?: string;
      }[];
    };
    const sources = (payload.items ?? []).map((it) => ({
      pid: it.pid,
      bundleId: it.bundle_id ?? it.owner_bundle_id ?? null,
      name: it.name ?? null,
      isMeetingApp: it.is_meeting_app ?? false,
      // Default true when the helper doesn't emit the field (older binary):
      // better to show a live list than hide everything behind "idle" dimming.
      isRunningOutput: it.is_running_output ?? true,
      // Older helper binaries don't attribute owners; treat every named
      // process as user-facing then, so nothing usable disappears.
      isUserApp: it.is_user_app ?? (it.name != null),
      ownerPid: it.owner_pid ?? it.pid,
      ownerName: it.owner_name ?? it.name ?? null,
      ownerBundleId: it.owner_bundle_id ?? it.bundle_id ?? null,
    }));
    return attributeOwners(sources);
  }
}

/** Share app identity/badges without discarding independently tappable PIDs.
 * A process tap targets one PID, so collapsing audible siblings loses audio. */
export function attributeOwners(sources: AudioSource[]): AudioSource[] {
  const meetingOwners = new Set(sources.filter(s => s.isUserApp && s.isMeetingApp).map(s => s.ownerPid));
  const seen = new Set<number>();
  const out: AudioSource[] = [];
  for (const s of sources) {
    if (seen.has(s.pid)) continue;
    seen.add(s.pid);
    out.push({ ...s, isMeetingApp: s.isMeetingApp || (s.isUserApp && meetingOwners.has(s.ownerPid)) });
  }
  return out.sort((a,b) => Number(b.isRunningOutput) - Number(a.isRunningOutput));
}
