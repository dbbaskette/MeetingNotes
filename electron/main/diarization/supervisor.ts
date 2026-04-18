import type { ChildProcess } from 'node:child_process';
import { spawn as realSpawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface SupervisorDeps {
  spawn?: typeof realSpawn;
  sidecarDir: string;
  host?: string;
  port?: number;
  maxRestarts?: number;
  restartDelayMs?: number;
  /** Process must stay up at least this long for the restart counter to reset. */
  healthyUptimeMs?: number;
  /** Hard kill timeout when stopping. */
  stopGraceMs?: number;
  onLog?: (line: string) => void;
  /** Override for tests. Probes /health on host:port and resolves true if a working sidecar is already there. */
  healthProbe?: (host: string, port: number) => Promise<boolean>;
}

const PORT_IN_USE_RE = /address already in use|errno 48/i;

async function defaultHealthProbe(host: string, port: number): Promise<boolean> {
  try {
    const resp = await fetch(`http://${host}:${port}/health`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!resp.ok) return false;
    const body = (await resp.json().catch(() => null)) as { status?: string } | null;
    return body?.status === 'ok';
  } catch {
    return false;
  }
}

export class DiarizationSupervisor {
  private proc: ChildProcess | null = null;
  private restarts = 0;
  private stopped = false;
  private startedAt = 0;
  /** True when an externally-started sidecar already owns the port — we'll
   *  reuse it and refuse to kill it on shutdown. */
  private external = false;
  /** True when start aborted because the port is held by a foreign process. */
  private portConflict = false;
  private readonly spawnFn: typeof realSpawn;
  private readonly maxRestarts: number;
  private readonly restartDelay: number;
  private readonly healthyUptime: number;
  private readonly stopGrace: number;
  private readonly probe: (host: string, port: number) => Promise<boolean>;

  constructor(private readonly deps: SupervisorDeps) {
    this.spawnFn = deps.spawn ?? realSpawn;
    this.maxRestarts = deps.maxRestarts ?? 3;
    this.restartDelay = deps.restartDelayMs ?? 1000;
    this.healthyUptime = deps.healthyUptimeMs ?? 60_000;
    this.stopGrace = deps.stopGraceMs ?? 5000;
    this.probe = deps.healthProbe ?? defaultHealthProbe;
  }

  async start(): Promise<void> {
    if (this.proc || this.external || this.stopped || this.portConflict) return;
    const host = this.deps.host ?? '127.0.0.1';
    const port = this.deps.port ?? 8765;

    // Pre-flight: if a healthy sidecar already owns the port (e.g. a debugger
    // or a leftover from a previous run that survived shutdown), reuse it.
    if (await this.probe(host, port)) {
      this.external = true;
      this.deps.onLog?.(`sidecar: reusing existing instance at ${host}:${port}`);
      return;
    }

    const launch = this.resolveLaunch(host, port);
    let proc: ChildProcess;
    try {
      proc = this.spawnFn(launch.cmd, launch.args, { cwd: this.deps.sidecarDir });
    } catch (e) {
      this.deps.onLog?.(`spawn failed: ${String(e)}`);
      this.scheduleRestart();
      return;
    }
    this.proc = proc;
    this.startedAt = Date.now();
    proc.stdout?.on('data', (d: Buffer) => this.onChildOutput(d, host, port));
    proc.stderr?.on('data', (d: Buffer) => this.onChildOutput(d, host, port));
    proc.on('error', (err) => {
      // ENOENT (missing python venv) lands here; without this listener it
      // becomes an uncaught error event and crashes the main process.
      this.deps.onLog?.(`sidecar error: ${String(err)}`);
    });
    proc.on('exit', (code, signal) => {
      const uptime = Date.now() - this.startedAt;
      this.proc = null;
      this.deps.onLog?.(`sidecar exited code=${code} signal=${signal} uptime=${uptime}ms`);
      if (this.stopped) return;
      if (this.portConflict) return;     // foreign owner; don't fight it
      if (uptime >= this.healthyUptime) this.restarts = 0;
      this.scheduleRestart();
    });
  }

  private onChildOutput(d: Buffer, host: string, port: number): void {
    const line = d.toString();
    this.deps.onLog?.(line);
    if (PORT_IN_USE_RE.test(line) && !this.portConflict) {
      this.portConflict = true;
      // Re-probe: maybe the squatter IS a working sidecar we can reuse.
      void this.probe(host, port).then((ok) => {
        if (ok) {
          this.external = true;
          this.deps.onLog?.(`sidecar: port ${port} held by working instance — reusing`);
        } else {
          this.deps.onLog?.(
            `sidecar: port ${port} held by foreign process (not a sidecar). ` +
            `Free it with: lsof -ti :${port} | xargs kill -9`,
          );
        }
      });
      // Stop the loop either way; on-exit handler checks portConflict.
      try { this.proc?.kill('SIGTERM'); } catch { /* noop */ }
    }
  }

  // Prefer the venv when it exists (dev iteration: edits to .py files are
  // picked up on next sidecar restart, no PyInstaller rebuild needed). The
  // bundle is the fallback for shipped .apps where end users have no venv.
  private resolveLaunch(host: string, port: number): { cmd: string; args: string[] } {
    const venvPython = path.join(this.deps.sidecarDir, '.venv', 'bin', 'python');
    if (fs.existsSync(venvPython)) {
      return {
        cmd: venvPython,
        args: ['-m', 'uvicorn', 'meeting_notes_diarize.app:app', '--host', host, '--port', String(port)],
      };
    }
    const bundled = path.join(
      this.deps.sidecarDir, 'dist', 'meeting-notes-diarize', 'meeting-notes-diarize',
    );
    return { cmd: bundled, args: ['--host', host, '--port', String(port)] };
  }

  private scheduleRestart(): void {
    if (this.stopped || this.portConflict || this.external) return;
    if (this.restarts >= this.maxRestarts) {
      this.deps.onLog?.(`sidecar restart budget exhausted (${this.maxRestarts})`);
      return;
    }
    this.restarts += 1;
    setTimeout(() => { void this.start(); }, this.restartDelay);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.external) {
      // We didn't start it; leaving it alone for whoever did.
      this.deps.onLog?.('sidecar: not stopping externally-owned instance');
      return;
    }
    const proc = this.proc;
    if (!proc) return;
    const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()));
    proc.kill('SIGTERM');
    const timeout = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), this.stopGrace));
    const result = await Promise.race([exited.then(() => 'ok' as const), timeout]);
    if (result === 'timeout' && this.proc) {
      this.proc.kill('SIGKILL');
      await exited;
    }
    this.proc = null;
  }

  isRunning(): boolean { return this.proc !== null || this.external; }
  /** True if start aborted because something else owns the port and isn't a sidecar. */
  hasPortConflict(): boolean { return this.portConflict && !this.external; }
}
