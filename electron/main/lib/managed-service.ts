// electron/main/lib/managed-service.ts
//
// Lifecycle controller for any HTTP-fronted child process we manage:
// pyannote sidecar (diarization), whisper-server (STT), and eventually
// LM Studio / Ollama (summary LLM). Replaces the old eager-start
// supervisor pattern. Three behavior knobs distinguish this from a
// plain spawn():
//
//   1. Lazy spawn via ensureReady() — the process is not started at
//      app launch. The first pipeline stage that needs the service
//      calls ensureReady(), which spawns + polls /health until ok.
//      Concurrent ensureReady() calls share the same start promise.
//
//   2. Idle shutdown — every ensureReady() call resets a timer.
//      After idleShutdownMs of no calls, stop() is invoked
//      automatically. Frees RAM (1.5 GB for whisper, 500 MB for
//      pyannote) when the user isn't actively transcribing.
//      idleShutdownMs <= 0 keeps the service always-on once started.
//
//   3. Adopt-existing — if /health is already ok at the configured
//      port (e.g. user has whisper-server running as a daemon), we
//      mark the service `external` and don't try to manage its
//      lifecycle. Idle shutdown does NOT kill external instances.
//
// All other behavior (restart-on-crash budget, port-conflict
// detection, build-id check for stale-vs-fresh, SIGTERM-then-
// SIGKILL stop) is carried over from the original supervisor.

import type { ChildProcess } from 'node:child_process';
import { spawn as realSpawn } from 'node:child_process';

export interface ProbeResult {
  ok: boolean;
  /** Optional version stamp the service reports on /health.
   *  When set on both sides (probe + expectedBuildId), a mismatch
   *  causes us to kill the running instance and respawn — this is
   *  what catches "I rebuilt the bundle but the bug is still there"
   *  cases when an old sidecar is still bound to the port. */
  buildId?: string;
}

export interface LaunchSpec {
  cmd: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export interface ManagedServiceDeps {
  /** Used in log lines and error messages. */
  name: string;
  host?: string;
  port: number;
  /** Builds the spawn arguments. Called each start so it can read
   *  current settings (e.g. which whisper model is selected). */
  resolveLaunch: (host: string, port: number) => LaunchSpec;
  /** Defaults to GET http://${host}:${port}/health expecting
   *  { status: 'ok', build_id?: string }. */
  healthProbe?: (host: string, port: number) => Promise<ProbeResult>;
  /** Returns the build_id the bundle on disk claims to have, or '' if
   *  the service doesn't have one. Compared against the running
   *  instance's reported buildId at adopt time. */
  expectedBuildId?: () => string;
  /** Test seam. */
  spawn?: typeof realSpawn;
  maxRestarts?: number;
  restartDelayMs?: number;
  /** Process must stay up at least this long for restart counter to reset. */
  healthyUptimeMs?: number;
  /** Hard kill timeout when stopping. */
  stopGraceMs?: number;
  /** When > 0, stop() fires automatically after this many ms of no
   *  ensureReady() calls. 0 / undefined = always-on once started. */
  idleShutdownMs?: number;
  /** Max time ensureReady() waits for /health to come up after spawn. */
  startupTimeoutMs?: number;
  /** How many cold-start attempts to make before giving up. Each attempt
   *  spawns (or reuses) a process and polls /health for up to
   *  {@link startupAttemptTimeoutMs}. Between attempts a wedged
   *  (alive-but-never-healthy) process is force-killed and respawned.
   *  Default 1 — single attempt, the historical behavior. Services prone
   *  to wedging on cold start (whisper) set this > 1. */
  startupMaxAttempts?: number;
  /** Per-attempt /health timeout. Defaults to {@link startupTimeoutMs} so
   *  single-attempt services are unchanged. With N attempts the total
   *  worst-case wait is N × this value. */
  startupAttemptTimeoutMs?: number;
  /** Health-poll interval during ensureReady(). */
  startupPollIntervalMs?: number;
  /** Stderr lines matching this regex flag a port conflict. */
  portInUseRe?: RegExp;
  /** Best-effort port-freeing helper (used when adoption build_id mismatches). */
  killOnPort?: (port: number) => Promise<void>;
  onLog?: (line: string) => void;
}

const DEFAULT_PORT_IN_USE_RE = /address already in use|errno 48/i;

async function defaultHealthProbe(
  host: string,
  port: number,
): Promise<ProbeResult> {
  try {
    const resp = await fetch(`http://${host}:${port}/health`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!resp.ok) return { ok: false };
    const body = (await resp.json().catch(() => null)) as
      | { status?: string; build_id?: string }
      | null;
    return { ok: body?.status === 'ok', buildId: body?.build_id };
  } catch {
    return { ok: false };
  }
}

/** Shell command to free a TCP port by killing whatever is LISTENING on it.
 *
 *  CRITICAL: this must select listeners only (`-sTCP:LISTEN`). The naive
 *  `lsof -ti :PORT` matches BOTH ends of every socket on the port — so it
 *  also returns our own Electron main process, which holds a keep-alive
 *  client connection to the sidecar/whisper `/health` endpoint from the
 *  adoption probe we just made. Piping that into `kill -9` SIGKILLs the app
 *  itself (no crash report — it's a signal, not a fault), which is exactly
 *  what "the app crashes when I click Process" was. Restricting to LISTEN
 *  kills the stale server we meant to replace and nothing else. */
export function killPortCommand(port: number): string {
  return `lsof -t -nP -iTCP:${port} -sTCP:LISTEN | xargs kill -9 2>/dev/null || true`;
}

async function defaultKillOnPort(port: number): Promise<void> {
  // Best-effort: free the port so we can respawn. Only invoked when
  // we've decided the current owner is a stale instance of ours
  // (build_id mismatch).
  const { spawn } = await import('node:child_process');
  await new Promise<void>((resolve) => {
    const p = spawn('sh', ['-c', killPortCommand(port)]);
    p.on('exit', () => resolve());
    p.on('error', () => resolve());
  });
  // Give the OS a beat to release the port.
  await new Promise((r) => setTimeout(r, 250));
}

export class ManagedService {
  private proc: ChildProcess | null = null;
  private restarts = 0;
  private stopped = false;
  private startedAt = 0;
  /** True when an externally-started instance owns the port — we'll
   *  reuse it and refuse to kill it on shutdown / idle timeout. */
  private external = false;
  /** True when start aborted because a foreign process holds the port. */
  private portConflict = false;
  /** Currently in-flight start; concurrent ensureReady calls await this. */
  private startPromise: Promise<void> | null = null;
  /** Currently in-flight stop; ensureReady awaits this so a (re)start never
   *  races a teardown (e.g. an idle shutdown that just fired). */
  private stopping: Promise<void> | null = null;
  /** Set while we deliberately kill a wedged process between cold-start
   *  attempts, so the exit handler doesn't trigger scheduleRestart and
   *  spawn a competing process. */
  private suppressRestart = false;
  private idleTimer: NodeJS.Timeout | null = null;

  private readonly spawnFn: typeof realSpawn;
  private readonly maxRestarts: number;
  private readonly restartDelay: number;
  private readonly healthyUptime: number;
  private readonly stopGrace: number;
  private readonly idleShutdownMs: number;
  private readonly startupTimeoutMs: number;
  private readonly startupMaxAttempts: number;
  private readonly startupAttemptTimeoutMs: number;
  private readonly startupPollIntervalMs: number;
  private readonly probe: (host: string, port: number) => Promise<ProbeResult>;
  private readonly killPort: (port: number) => Promise<void>;
  private readonly portInUseRe: RegExp;

  constructor(private readonly deps: ManagedServiceDeps) {
    this.spawnFn = deps.spawn ?? realSpawn;
    this.maxRestarts = deps.maxRestarts ?? 3;
    this.restartDelay = deps.restartDelayMs ?? 1000;
    this.healthyUptime = deps.healthyUptimeMs ?? 60_000;
    this.stopGrace = deps.stopGraceMs ?? 5000;
    this.idleShutdownMs = deps.idleShutdownMs ?? 0;
    this.startupTimeoutMs = deps.startupTimeoutMs ?? 30_000;
    this.startupMaxAttempts = Math.max(1, deps.startupMaxAttempts ?? 1);
    this.startupAttemptTimeoutMs =
      deps.startupAttemptTimeoutMs ?? this.startupTimeoutMs;
    this.startupPollIntervalMs = deps.startupPollIntervalMs ?? 250;
    this.probe = deps.healthProbe ?? defaultHealthProbe;
    this.killPort = deps.killOnPort ?? defaultKillOnPort;
    this.portInUseRe = deps.portInUseRe ?? DEFAULT_PORT_IN_USE_RE;
  }

  /** Spawn the service if it isn't running, wait until /health returns
   *  ok, and reset the idle timer. Idempotent: concurrent calls share
   *  the same start operation. */
  async ensureReady(): Promise<void> {
    // If a stop is mid-flight (e.g. the idle timer just fired), let it
    // finish before we decide whether to (re)start. Otherwise we'd probe a
    // dying process, see this.proc still set, and poll a corpse until the
    // startup timeout — the production "not ready within 120000ms" race.
    if (this.stopping) await this.stopping;
    if (this.stopped) {
      // After explicit stop or idle shutdown, allow re-entry.
      this.stopped = false;
      this.restarts = 0;
      this.portConflict = false;
    }
    this.resetIdleTimer();

    const host = this.deps.host ?? '127.0.0.1';
    const port = this.deps.port;

    if (this.external) {
      // External instance — verify it's still healthy. If it died,
      // fall through to spawn our own.
      const probe = await this.probe(host, port);
      if (probe.ok) return;
      this.external = false;
      this.deps.onLog?.(`${this.deps.name}: external instance gone, will take over`);
    }

    if (this.proc) {
      // Already spawned — verify health. If unhealthy, the exit
      // handler will trigger a restart; we wait through the new
      // startPromise.
      const probe = await this.probe(host, port);
      if (probe.ok) return;
    }

    if (!this.startPromise) {
      this.startPromise = this.startInternal()
        .finally(() => {
          this.startPromise = null;
        });
    }
    return this.startPromise;
  }

  private async startInternal(): Promise<void> {
    if (this.external || this.portConflict) return;
    const host = this.deps.host ?? '127.0.0.1';
    const port = this.deps.port;

    // Pre-flight: probe for an existing healthy instance. If found,
    // compare its build_id (when both sides report one) against what
    // we shipped on disk — match means adopt-and-leave-alone, mismatch
    // means kill and respawn.
    if (!this.proc) {
      const expectedBuildId = this.deps.expectedBuildId?.() ?? '';
      const probe = await this.probe(host, port);
      if (probe.ok) {
        const buildIdsKnown = expectedBuildId && probe.buildId;
        if (!buildIdsKnown || probe.buildId === expectedBuildId) {
          this.external = true;
          this.deps.onLog?.(
            `${this.deps.name}: reusing existing instance at ${host}:${port}` +
            (probe.buildId ? ` (build_id=${probe.buildId})` : ''),
          );
          return;
        }
        this.deps.onLog?.(
          `${this.deps.name}: stale instance at ${host}:${port} ` +
          `(running=${probe.buildId}, expected=${expectedBuildId}) — killing and respawning`,
        );
        await this.killPort(port);
      }
    }

    // Cold-start attempt loop. Each attempt spawns (or reuses) a process
    // and polls /health. A process that loads but never reports healthy
    // does NOT exit on its own — so the exit-driven restart never fires.
    // We detect that here (poll timeout with the process still alive),
    // force-kill the wedged instance, and cold-start again.
    for (let attempt = 1; attempt <= this.startupMaxAttempts; attempt += 1) {
      if (!this.proc) this.spawnProc(host, port);

      const outcome = await this.pollHealth(host, port);
      if (outcome === 'ok') return;
      if (outcome === 'exited') {
        throw new Error(
          `${this.deps.name}: process exited before becoming healthy`,
        );
      }
      if (outcome === 'port-conflict') {
        throw new Error(`${this.deps.name}: port ${port} in use`);
      }

      // outcome === 'timeout': the process is alive but never went healthy.
      if (attempt < this.startupMaxAttempts) {
        this.deps.onLog?.(
          `${this.deps.name}: not healthy within ${this.startupAttemptTimeoutMs}ms — ` +
            `killing wedged process and respawning (attempt ${attempt + 1}/${this.startupMaxAttempts})`,
        );
        await this.killAndAwaitExit();
      }
    }

    const totalMs = this.startupMaxAttempts * this.startupAttemptTimeoutMs;
    throw new Error(
      `${this.deps.name}: not ready within ${totalMs}ms after ${this.startupMaxAttempts} attempt(s)`,
    );
  }

  /** Spawn the child and wire up its output/exit handlers. Assumes
   *  this.proc is null. */
  private spawnProc(host: string, port: number): void {
    const launch = this.deps.resolveLaunch(host, port);
    let proc: ChildProcess;
    try {
      proc = this.spawnFn(launch.cmd, launch.args, {
        cwd: launch.cwd,
        env: launch.env ?? process.env,
      });
    } catch (e) {
      this.deps.onLog?.(`${this.deps.name}: spawn failed: ${String(e)}`);
      throw e;
    }
    this.proc = proc;
    this.startedAt = Date.now();
    proc.stdout?.on('data', (d: Buffer) => this.onChildOutput(d, host, port));
    proc.stderr?.on('data', (d: Buffer) => this.onChildOutput(d, host, port));
    proc.on('error', (err) => {
      // ENOENT (binary not found) lands here — must be handled to
      // prevent uncaught error events crashing the main process.
      this.deps.onLog?.(`${this.deps.name}: error: ${String(err)}`);
    });
    proc.on('exit', (code, signal) => {
      const uptime = Date.now() - this.startedAt;
      this.proc = null;
      this.deps.onLog?.(
        `${this.deps.name}: exited code=${code} signal=${signal} uptime=${uptime}ms`,
      );
      if (this.stopped) return;
      if (this.portConflict) return;
      // A kill we issued deliberately to respawn a wedged process — the
      // attempt loop will spawn the replacement, so don't double-spawn.
      if (this.suppressRestart) return;
      if (uptime >= this.healthyUptime) this.restarts = 0;
      this.scheduleRestart();
    });
  }

  /** Poll /health until ok, the process exits, a port conflict surfaces,
   *  or the per-attempt timeout elapses. The child takes a beat to bind
   *  the socket and (for pyannote) load the model — we MUST wait or the
   *  first pipeline call will hit ECONNREFUSED. */
  private async pollHealth(
    host: string,
    port: number,
  ): Promise<'ok' | 'exited' | 'port-conflict' | 'timeout'> {
    const deadline = Date.now() + this.startupAttemptTimeoutMs;
    while (Date.now() < deadline) {
      if (!this.proc) return 'exited';
      if (this.portConflict) return 'port-conflict';
      const p = await this.probe(host, port);
      if (p.ok) return 'ok';
      await new Promise((r) => setTimeout(r, this.startupPollIntervalMs));
    }
    return 'timeout';
  }

  /** Force-kill the current process and wait for it to actually exit,
   *  without tripping the auto-restart path. Used between cold-start
   *  attempts to replace a wedged process. */
  private async killAndAwaitExit(): Promise<void> {
    const proc = this.proc;
    if (!proc) return;
    this.suppressRestart = true;
    const exited = new Promise<void>((resolve) =>
      proc.once('exit', () => resolve()),
    );
    try {
      proc.kill('SIGKILL');
    } catch {
      /* already gone */
    }
    await exited;
    this.proc = null;
    this.suppressRestart = false;
  }

  private onChildOutput(d: Buffer, host: string, port: number): void {
    const line = d.toString();
    this.deps.onLog?.(line);
    if (this.portInUseRe.test(line) && !this.portConflict) {
      this.portConflict = true;
      // Re-probe: maybe the squatter is actually a working instance we
      // can adopt. If not, surface a clear "free the port manually"
      // message and stop the restart loop.
      void this.probe(host, port).then(({ ok }) => {
        if (ok) {
          this.external = true;
          this.deps.onLog?.(
            `${this.deps.name}: port ${port} held by working instance — reusing`,
          );
        } else {
          this.deps.onLog?.(
            `${this.deps.name}: port ${port} held by foreign process. ` +
            `Free with: ${killPortCommand(port)}`,
          );
        }
      });
      try { this.proc?.kill('SIGTERM'); } catch { /* noop */ }
    }
  }

  private scheduleRestart(): void {
    if (this.stopped || this.portConflict || this.external) return;
    if (this.restarts >= this.maxRestarts) {
      this.deps.onLog?.(`${this.deps.name}: restart budget exhausted (${this.maxRestarts})`);
      return;
    }
    this.restarts += 1;
    setTimeout(() => {
      void this.startInternal().catch((e) => {
        this.deps.onLog?.(`${this.deps.name}: restart failed: ${String(e)}`);
      });
    }, this.restartDelay);
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.idleShutdownMs <= 0) return;
    this.idleTimer = setTimeout(() => {
      this.deps.onLog?.(
        `${this.deps.name}: idle for ${this.idleShutdownMs}ms — shutting down`,
      );
      void this.stop();
    }, this.idleShutdownMs);
  }

  /** Explicit shutdown. Idempotent. Does NOT kill an externally-owned
   *  instance — we only stop processes we spawned. Concurrent calls (and
   *  an ensureReady that arrives mid-teardown) share the same promise. */
  async stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopping = this.doStop().finally(() => {
      this.stopping = null;
    });
    return this.stopping;
  }

  private async doStop(): Promise<void> {
    this.stopped = true;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.external) {
      this.deps.onLog?.(`${this.deps.name}: not stopping externally-owned instance`);
      this.external = false;
      return;
    }
    const proc = this.proc;
    if (!proc) return;
    const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()));
    proc.kill('SIGTERM');
    const timeout = new Promise<'timeout'>((resolve) =>
      setTimeout(() => resolve('timeout'), this.stopGrace),
    );
    const result = await Promise.race([exited.then(() => 'ok' as const), timeout]);
    if (result === 'timeout' && this.proc) {
      this.proc.kill('SIGKILL');
      await exited;
    }
    this.proc = null;
  }

  isRunning(): boolean {
    return this.proc !== null || this.external;
  }

  /** True if start aborted because a foreign process owns the port
   *  and isn't a valid instance of our service. */
  hasPortConflict(): boolean {
    return this.portConflict && !this.external;
  }
}
