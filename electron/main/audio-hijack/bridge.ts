import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const pExecFile = promisify(execFile);

export type Runner = (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

const defaultRunner: Runner = (cmd, args) => pExecFile(cmd, args, { timeout: 10000 });

export class AudioHijackError extends Error {}

export class AudioHijackBridge {
  private readonly runner: Runner;
  constructor(deps: { runner?: Runner } = {}) { this.runner = deps.runner ?? defaultRunner; }

  private async runScript(script: string): Promise<string> {
    const { stdout, stderr } = await this.runner('osascript', ['-e', script]);
    if (stderr.trim()) throw new AudioHijackError(`Audio Hijack error: ${stderr.trim()}`);
    return stdout.trim();
  }

  async startSession(name: string): Promise<void> {
    const safe = name.replace(/"/g, '\\"');
    await this.runScript(`tell application "Audio Hijack" to start session "${safe}"`);
  }

  async stopSession(name: string): Promise<void> {
    const safe = name.replace(/"/g, '\\"');
    await this.runScript(`tell application "Audio Hijack" to stop session "${safe}"`);
  }

  async sessionState(name: string): Promise<'running' | 'stopped' | 'unknown'> {
    const safe = name.replace(/"/g, '\\"');
    const s = await this.runScript(`tell application "Audio Hijack" to get running of session "${safe}"`);
    if (s === 'true') return 'running';
    if (s === 'false') return 'stopped';
    return 'unknown';
  }
}
