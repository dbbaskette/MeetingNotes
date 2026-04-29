// electron/main/diarization/supervisor.ts
//
// Pyannote-specific factory over ManagedService. The lifecycle logic
// (spawn, restart budget, idle shutdown, adopt-existing) lives in
// the shared ManagedService class — this file just supplies the
// pyannote-specific bits: where to find the binary (venv in dev vs
// bundled PyInstaller in a packaged .app), how to inject HF_TOKEN,
// and how to read the on-disk BUILD_ID for stale-vs-fresh adoption.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ManagedService,
  type ManagedServiceDeps,
  type LaunchSpec,
} from '../lib/managed-service.js';

/**
 * Resolves an HF_TOKEN to inject into the sidecar's environment.
 * Priority: existing env var → standard HuggingFace cache file. The
 * .app launched via `open` doesn't inherit shell env vars, so we
 * read the cache file directly. Returns null when no token is
 * available; the sidecar will surface its own clear error in that case.
 */
function readHFToken(): string | null {
  if (process.env.HF_TOKEN) return process.env.HF_TOKEN;
  const tokenFile = path.join(os.homedir(), '.cache', 'huggingface', 'token');
  try {
    const t = fs.readFileSync(tokenFile, 'utf8').trim();
    return t.length > 0 ? t : null;
  } catch {
    return null;
  }
}

function readExpectedBuildId(sidecarDir: string): string {
  // BUILD_ID is written next to the bundle during `npm run sidecar:bundle`.
  // Matches the _read_build_id search order in app.py.
  for (const p of [
    path.join(sidecarDir, 'BUILD_ID'),
    path.join(sidecarDir, 'dist', 'BUILD_ID'),
  ]) {
    try {
      if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8').trim();
    } catch {
      /* noop */
    }
  }
  return '';
}

// Prefer the venv when it exists (dev iteration: edits to .py files
// are picked up on next sidecar restart, no PyInstaller rebuild
// needed). The bundle is the fallback for shipped .apps where end
// users have no venv.
function resolvePyannoteLaunch(
  sidecarDir: string,
  host: string,
  port: number,
): LaunchSpec {
  const venvPython = path.join(sidecarDir, '.venv', 'bin', 'python');
  const hfToken = readHFToken();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...(hfToken ? { HF_TOKEN: hfToken } : {}),
  };
  if (fs.existsSync(venvPython)) {
    return {
      cmd: venvPython,
      args: [
        '-m', 'uvicorn',
        'meeting_notes_diarize.app:app',
        '--host', host,
        '--port', String(port),
      ],
      env,
      cwd: sidecarDir,
    };
  }
  const bundled = path.join(
    sidecarDir, 'dist', 'meeting-notes-diarize', 'meeting-notes-diarize',
  );
  return {
    cmd: bundled,
    args: ['--host', host, '--port', String(port)],
    env,
    cwd: sidecarDir,
  };
}

export interface DiarizationSupervisorOpts {
  sidecarDir: string;
  /** Override for tests. */
  spawn?: ManagedServiceDeps['spawn'];
  /** Override for tests. */
  healthProbe?: ManagedServiceDeps['healthProbe'];
  host?: string;
  port?: number;
  maxRestarts?: number;
  restartDelayMs?: number;
  healthyUptimeMs?: number;
  stopGraceMs?: number;
  /** Default 10 min. Set to 0 to disable. */
  idleShutdownMs?: number;
  startupTimeoutMs?: number;
  startupPollIntervalMs?: number;
  onLog?: (line: string) => void;
}

const DEFAULT_IDLE_SHUTDOWN_MS = 10 * 60 * 1000; // 10 minutes

/** Build a ManagedService configured for the pyannote diarization sidecar. */
export function createDiarizationSupervisor(
  opts: DiarizationSupervisorOpts,
): ManagedService {
  return new ManagedService({
    name: 'sidecar',
    host: opts.host ?? '127.0.0.1',
    port: opts.port ?? 8765,
    spawn: opts.spawn,
    healthProbe: opts.healthProbe,
    maxRestarts: opts.maxRestarts ?? 3,
    restartDelayMs: opts.restartDelayMs ?? 1000,
    healthyUptimeMs: opts.healthyUptimeMs ?? 60_000,
    stopGraceMs: opts.stopGraceMs ?? 5000,
    idleShutdownMs: opts.idleShutdownMs ?? DEFAULT_IDLE_SHUTDOWN_MS,
    // Pyannote needs more than 30s on first run because it downloads
    // model weights from HuggingFace. Subsequent runs read from the
    // local HF cache and warm up in 5-10s. 90s is a sane upper bound
    // for both cold + warm starts.
    startupTimeoutMs: opts.startupTimeoutMs ?? 90_000,
    startupPollIntervalMs: opts.startupPollIntervalMs ?? 250,
    expectedBuildId: () => readExpectedBuildId(opts.sidecarDir),
    resolveLaunch: (host, port) => resolvePyannoteLaunch(opts.sidecarDir, host, port),
    onLog: opts.onLog,
  });
}
