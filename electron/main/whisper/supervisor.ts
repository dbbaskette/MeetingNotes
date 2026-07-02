// electron/main/whisper/supervisor.ts
//
// Whisper-server-specific factory over ManagedService. Mirrors
// scripts/whisper-server.sh's behavior in TS: locate the
// whisper-server binary across brew prefixes / PATH, resolve a
// model file under ~/Library/Application Support/MeetingNotes/
// whisper-models/, then launch with --model/--host/--port. The
// shared lifecycle machinery (lazy spawn, idle shutdown, restart
// budget, adopt-existing-daemon) lives in ManagedService.
//
// We deliberately bypass scripts/whisper-server.sh for managed
// mode: the script's daemon logic writes a PID file we'd have to
// reason about, and a `nohup`'d child can outlive our supervisor
// in ways we don't want. Spawning whisper-server directly keeps
// the lifecycle entirely in Node's hands.
//
// The script stays in the repo for users who prefer manual
// management — the supervisor adopts a healthy whisper-server on
// :8080 regardless of who started it (build_id check is bypassed
// because whisper-server doesn't expose one).

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ManagedService,
  type ManagedServiceDeps,
  type LaunchSpec,
  type ProbeResult,
} from '../lib/managed-service.js';

/** Locate the whisper-server binary. Tries `which`, then known brew
 *  prefixes (Apple Silicon /opt/homebrew, Intel /usr/local). Throws
 *  with a helpful message if not found — caught by ensureReady() in
 *  the spawn-failed branch. */
export function findWhisperBinary(): string {
  // 1. PATH
  try {
    const out = execFileSync('which', ['whisper-server'], { encoding: 'utf8' }).trim();
    if (out) return out;
  } catch { /* fall through */ }
  // 2. whisper-cli (older releases packaged this name)
  try {
    const out = execFileSync('which', ['whisper-cli'], { encoding: 'utf8' }).trim();
    if (out) return out;
  } catch { /* fall through */ }
  // 3. Known brew install paths
  const brewPaths = [
    '/opt/homebrew/bin/whisper-server',
    '/opt/homebrew/opt/whisper-cpp/bin/whisper-server',
    '/usr/local/bin/whisper-server',
    '/usr/local/opt/whisper-cpp/bin/whisper-server',
  ];
  for (const p of brewPaths) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error(
    'whisper-server binary not found. Install with: brew install whisper-cpp',
  );
}

/** Computed lazily so tests can stub HOME. We prefer $HOME over
 *  os.homedir() because Node 22+ on macOS sometimes resolves
 *  os.homedir() via getpwuid_r and ignores HOME — that breaks the
 *  test override. */
export function modelsDir(): string {
  const home = process.env.HOME ?? os.homedir();
  return path.join(
    home,
    'Library',
    'Application Support',
    'MeetingNotes',
    'whisper-models',
  );
}

/** Mirrors auto_pick_model in scripts/whisper-server.sh — preference
 *  ordering favors English meeting accuracy with reasonable speed. */
const MODEL_PREFERENCE = [
  'medium.en', 'medium', 'small.en', 'small',
  'large-v3-turbo', 'large-v3',
  'base.en', 'base', 'tiny.en', 'tiny',
];

/** Resolve a model file path. Settings carry the user's chosen model
 *  id (e.g. "medium.en"); we map it to a `ggml-<id>.bin` under the
 *  app's whisper-models directory. If the explicit model isn't
 *  installed, fall back to the auto-picked preference order so the
 *  app still works even when settings are stale. */
export function resolveModelPath(modelId: string | null | undefined): string {
  const dir = modelsDir();
  const candidates: string[] = [];
  if (modelId && modelId !== 'whisper-1' /* placeholder default */) {
    candidates.push(modelId);
  }
  candidates.push(...MODEL_PREFERENCE);
  for (const id of candidates) {
    const p = path.join(dir, `ggml-${id}.bin`);
    if (fs.existsSync(p)) return p;
  }
  // Last resort: any ggml-*.bin in the dir.
  if (fs.existsSync(dir)) {
    const found = fs.readdirSync(dir)
      .find((f) => f.startsWith('ggml-') && f.endsWith('.bin'));
    if (found) return path.join(dir, found);
  }
  throw new Error(
    `No whisper model installed. Run the onboarding wizard or ` +
    `./scripts/whisper-server.sh install medium.en`,
  );
}

/** Whisper-server exposes a /health endpoint that returns 200 with
 *  the literal JSON body {"status":"ok"} once the model is loaded
 *  and the server is ready.
 *
 *  We parse and verify the body — not just the 200 — because port
 *  8080 is a popular default and many other things (Spring Boot SPAs,
 *  generic dev servers) happily return 200 from /health by virtue of
 *  a wildcard route serving index.html. Without the body check, the
 *  supervisor would "adopt" the wrong server and every transcribe
 *  call would die with a 4xx from a process that has no idea what
 *  whisper is. */
async function whisperHealthProbe(
  host: string,
  port: number,
): Promise<ProbeResult> {
  try {
    const resp = await fetch(`http://${host}:${port}/health`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!resp.ok) return { ok: false };
    // Whisper-server's body is tiny — read fully and confirm the
    // shape. A non-JSON body (HTML index, etc.) means it's not
    // whisper-server.
    const text = await resp.text();
    try {
      const parsed = JSON.parse(text) as { status?: unknown };
      return { ok: parsed?.status === 'ok' };
    } catch {
      return { ok: false };
    }
  } catch {
    return { ok: false };
  }
}

export interface WhisperSupervisorOpts {
  /** Reads the user's chosen model id from settings.sttModel. */
  getModelId: () => string | null | undefined;
  spawn?: ManagedServiceDeps['spawn'];
  healthProbe?: ManagedServiceDeps['healthProbe'];
  /** Override binary location (tests). */
  findBinary?: () => string;
  /** Override model resolution (tests). */
  resolveModel?: (modelId: string | null | undefined) => string;
  host?: string;
  port?: number;
  maxRestarts?: number;
  restartDelayMs?: number;
  healthyUptimeMs?: number;
  stopGraceMs?: number;
  /** Default 10 min. Set to 0 to disable. */
  idleShutdownMs?: number;
  startupTimeoutMs?: number;
  startupMaxAttempts?: number;
  startupAttemptTimeoutMs?: number;
  startupPollIntervalMs?: number;
  onLog?: (line: string) => void;
}

const DEFAULT_IDLE_SHUTDOWN_MS = 10 * 60 * 1000; // 10 minutes

/** Build a ManagedService configured for whisper-server. */
export function createWhisperSupervisor(
  opts: WhisperSupervisorOpts,
): ManagedService {
  const findBin = opts.findBinary ?? findWhisperBinary;
  const resolveMod = opts.resolveModel ?? resolveModelPath;
  return new ManagedService({
    name: 'whisper',
    host: opts.host ?? '127.0.0.1',
    port: opts.port ?? 8080,
    spawn: opts.spawn,
    healthProbe: opts.healthProbe ?? whisperHealthProbe,
    maxRestarts: opts.maxRestarts ?? 3,
    restartDelayMs: opts.restartDelayMs ?? 1000,
    healthyUptimeMs: opts.healthyUptimeMs ?? 60_000,
    stopGraceMs: opts.stopGraceMs ?? 5000,
    idleShutdownMs: opts.idleShutdownMs ?? DEFAULT_IDLE_SHUTDOWN_MS,
    // Whisper model load varies wildly: tiny.en ~1s, medium.en ~5s,
    // large-v3-turbo ~2s model load + up to 90s of Metal pipeline
    // compilation on first launch after a macOS or whisper-cpp update.
    // 120s covers that worst case comfortably.
    startupTimeoutMs: opts.startupTimeoutMs ?? 120_000,
    // Whisper occasionally loads the model but never reports /health
    // healthy and never exits (observed on cold starts). A single poll
    // window would just time out against the wedged process. Two attempts
    // of 60s each keep the same ~120s total budget but kill-and-respawn a
    // wedged process halfway instead of polling a corpse.
    startupMaxAttempts: opts.startupMaxAttempts ?? 2,
    startupAttemptTimeoutMs: opts.startupAttemptTimeoutMs ?? 60_000,
    startupPollIntervalMs: opts.startupPollIntervalMs ?? 250,
    resolveLaunch: (host, port): LaunchSpec => {
      const cmd = findBin();
      const modelPath = resolveMod(opts.getModelId());
      return {
        cmd,
        args: [
          '--model', modelPath,
          '--host', host,
          '--port', String(port),
        ],
      };
    },
    onLog: opts.onLog,
  });
}
