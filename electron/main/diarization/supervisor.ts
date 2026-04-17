import type { ChildProcess } from 'node:child_process';
import { spawn as realSpawn } from 'node:child_process';
import path from 'node:path';

export interface SupervisorDeps {
  spawn?: typeof realSpawn;
  sidecarDir: string;
  host?: string;
  port?: number;
  maxRestarts?: number;
  restartDelayMs?: number;
  onLog?: (line: string) => void;
}

export class DiarizationSupervisor {
  private proc: ChildProcess | null = null;
  private restarts = 0;
  private stopped = false;
  private readonly spawnFn: typeof realSpawn;
  private readonly maxRestarts: number;
  private readonly restartDelay: number;

  constructor(private readonly deps: SupervisorDeps) {
    this.spawnFn = deps.spawn ?? realSpawn;
    this.maxRestarts = deps.maxRestarts ?? 3;
    this.restartDelay = deps.restartDelayMs ?? 1000;
  }

  start(): void {
    if (this.proc) return;
    const venvPython = path.join(this.deps.sidecarDir, '.venv', 'bin', 'python');
    const host = this.deps.host ?? '127.0.0.1';
    const port = this.deps.port ?? 8765;
    const proc = this.spawnFn(
      venvPython,
      ['-m', 'uvicorn', 'meeting_notes_diarize.app:app', '--host', host, '--port', String(port)],
      { cwd: this.deps.sidecarDir },
    );
    this.proc = proc;
    proc.stdout?.on('data', (d: Buffer) => this.deps.onLog?.(d.toString()));
    proc.stderr?.on('data', (d: Buffer) => this.deps.onLog?.(d.toString()));
    proc.on('exit', () => {
      this.proc = null;
      if (this.stopped) return;
      if (this.restarts >= this.maxRestarts) return;
      this.restarts += 1;
      setTimeout(() => this.start(), this.restartDelay);
    });
  }

  stop(): void {
    this.stopped = true;
    this.proc?.kill();
    this.proc = null;
  }

  isRunning(): boolean { return this.proc !== null; }
}
