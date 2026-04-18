import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { escapeAppleScript } from '../exporters/interface.js';

const pExecFile = promisify(execFile);

export type Runner = (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

const defaultRunner: Runner = (cmd, args) => pExecFile(cmd, args, { timeout: 10000 });

export class AudioHijackError extends Error {}

// Audio Hijack's scripting dictionary won't parse the one-line
// `tell application "Audio Hijack" to start session "X"` form — `start` and
// `session` together confuse the parser. Use a multi-line tell block via
// multiple -e args.
function buildArgs(name: string, body: string): string[] {
  const safe = escapeAppleScript(name);
  return [
    '-e', 'tell application "Audio Hijack"',
    '-e', body.replace('{NAME}', `"${safe}"`),
    '-e', 'end tell',
  ];
}

export class AudioHijackBridge {
  private readonly runner: Runner;
  constructor(deps: { runner?: Runner } = {}) { this.runner = deps.runner ?? defaultRunner; }

  private async run(args: string[]): Promise<string> {
    const { stdout, stderr } = await this.runner('osascript', args);
    if (stderr.trim()) throw new AudioHijackError(`Audio Hijack error: ${stderr.trim()}`);
    return stdout.trim();
  }

  async startSession(name: string): Promise<void> {
    await this.run(buildArgs(name, 'start session named {NAME}'));
  }

  async stopSession(name: string): Promise<void> {
    await this.run(buildArgs(name, 'stop session named {NAME}'));
  }

  async sessionState(name: string): Promise<'running' | 'stopped' | 'unknown'> {
    const s = await this.run(buildArgs(name, 'get running of session named {NAME}'));
    if (s === 'true') return 'running';
    if (s === 'false') return 'stopped';
    return 'unknown';
  }
}
