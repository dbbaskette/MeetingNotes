// electron/main/llm/supervisor.ts
//
// Lifecycle for the summarization LLM. Mirrors the pyannote /
// whisper supervisor pattern (lazy spawn, idle shutdown, adopt
// existing daemon) but multiplexes across provider modes:
//
//   - 'external' → no-op. The user has LM Studio / Ollama / some
//     other OpenAI-compat server running; we don't manage its
//     lifecycle. (Backwards-compatible default.)
//   - 'lm-studio' → spawn `lms server start --port {port}` via
//     LM Studio's bundled CLI. Probes :1234/v1/models. The user
//     must still `lms load <model>` (or load via the GUI) for
//     the model to be served.
//   - 'ollama' → spawn `ollama serve`. Probes :11434/v1/models.
//     Ollama auto-loads/unloads models on its own (controlled by
//     OLLAMA_KEEP_ALIVE) so we don't need a separate model-load
//     step.
//
// Implementation is a thin dispatcher over three internal
// ManagedService instances (one per managed provider plus a no-op
// for 'external'). Each instance has its own idle timer and adopt
// logic. ensureReady() reads the current setting on every call so
// the user can switch providers in Settings without restarting
// the app.

import { execFileSync, execFile } from 'node:child_process';
import fs from 'node:fs';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
import {
  ManagedService,
  type ManagedServiceDeps,
  type ProbeResult,
} from '../lib/managed-service.js';

export type LLMProvider = 'external' | 'lm-studio' | 'ollama';

export interface LLMSupervisorOpts {
  /** Reads the user's chosen provider from settings.summaryProvider. */
  getProvider: () => LLMProvider;
  /** Reads settings.llmModel — used by the LM Studio auto-load step
   *  to bring the right model into VRAM after `lms server start`. */
  getModelId?: () => string | null | undefined;
  /** LM Studio's port (default 1234). */
  lmStudioPort?: number;
  /** Ollama's port (default 11434). */
  ollamaPort?: number;
  /** Default 10 min for both providers. */
  idleShutdownMs?: number;
  /** Test seam — bypass real PATH discovery. */
  findLmsBinary?: () => string;
  /** Test seam. */
  findOllamaBinary?: () => string;
  /** Test seam. */
  spawn?: ManagedServiceDeps['spawn'];
  /** Override health probes for tests. */
  lmStudioProbe?: ManagedServiceDeps['healthProbe'];
  ollamaProbe?: ManagedServiceDeps['healthProbe'];
  /** Test seam for the LM Studio model-load step. Defaults to
   *  shelling out via execFile to the resolved `lms` binary. */
  lmsLoadModel?: (binary: string, modelId: string) => Promise<void>;
  /** Test seam for the loaded-models check. Returns ids that LM
   *  Studio's /v1/models endpoint reports as currently loaded. */
  lmsListLoadedModels?: (host: string, port: number) => Promise<string[]>;
  onLog?: (line: string) => void;
}

const DEFAULT_IDLE_SHUTDOWN_MS = 10 * 60 * 1000;

/** Search common locations for the `lms` CLI shipped by LM Studio.app.
 *  LM Studio installs it at ~/.lmstudio/bin/lms by default but doesn't
 *  always symlink to /usr/local/bin. */
export function findLmsBinary(): string {
  try {
    const out = execFileSync('which', ['lms'], { encoding: 'utf8' }).trim();
    if (out) return out;
  } catch { /* fall through */ }
  const homeBin = `${process.env.HOME ?? ''}/.lmstudio/bin/lms`;
  if (fs.existsSync(homeBin)) return homeBin;
  // App-bundle fallback.
  const appBin = '/Applications/LM Studio.app/Contents/MacOS/lms';
  if (fs.existsSync(appBin)) return appBin;
  throw new Error(
    "LM Studio's `lms` CLI not found. Install LM Studio from " +
    'https://lmstudio.ai and ensure the CLI is in PATH (run ' +
    '`bootstrap` from inside the app, or add ~/.lmstudio/bin to PATH).',
  );
}

export function findOllamaBinary(): string {
  try {
    const out = execFileSync('which', ['ollama'], { encoding: 'utf8' }).trim();
    if (out) return out;
  } catch { /* fall through */ }
  for (const p of ['/opt/homebrew/bin/ollama', '/usr/local/bin/ollama']) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error(
    "ollama binary not found. Install with: brew install ollama " +
    "or download from https://ollama.com.",
  );
}

/** Health probe shape: GET /v1/models, return ok if 2xx. Both LM
 *  Studio and Ollama expose this OpenAI-compat endpoint. */
async function modelsListProbe(host: string, port: number): Promise<ProbeResult> {
  try {
    const resp = await fetch(`http://${host}:${port}/v1/models`, {
      signal: AbortSignal.timeout(1500),
    });
    return { ok: resp.ok };
  } catch {
    return { ok: false };
  }
}

/** Default implementation of "what's loaded right now" — hits LM
 *  Studio's /v1/models. Returns the list of model ids in `data[]`.
 *  Lifted out for testability. */
async function defaultLmsListLoaded(host: string, port: number): Promise<string[]> {
  const resp = await fetch(`http://${host}:${port}/v1/models`, {
    signal: AbortSignal.timeout(2000),
  });
  if (!resp.ok) return [];
  const body = (await resp.json().catch(() => null)) as
    | { data?: Array<{ id?: string }> }
    | null;
  const data = body?.data ?? [];
  return data.map((m) => m.id ?? '').filter((id) => id.length > 0);
}

/** Default model-load implementation — shells out to `lms load`.
 *  60s timeout matches the worst-case Q5 load time for a 7B-class
 *  model on Apple Silicon. */
async function defaultLmsLoadModel(binary: string, modelId: string): Promise<void> {
  await execFileAsync(binary, ['load', modelId], { timeout: 60_000 });
}

/** Reports which providers are available (binary present + reachable
 *  endpoint) so the Settings UI can dim unavailable options. Returns
 *  a snapshot — the values can change between calls. */
export interface ProviderAvailability {
  lmStudio: { binary: boolean; running: boolean };
  ollama: { binary: boolean; running: boolean };
}

export async function detectProviders(): Promise<ProviderAvailability> {
  let lmsBin = false;
  try { findLmsBinary(); lmsBin = true; } catch { /* not installed */ }
  let ollamaBin = false;
  try { findOllamaBinary(); ollamaBin = true; } catch { /* not installed */ }
  const [lmsRunning, ollamaRunning] = await Promise.all([
    modelsListProbe('127.0.0.1', 1234).then((r) => r.ok),
    modelsListProbe('127.0.0.1', 11434).then((r) => r.ok),
  ]);
  return {
    lmStudio: { binary: lmsBin, running: lmsRunning },
    ollama: { binary: ollamaBin, running: ollamaRunning },
  };
}

export class LLMSupervisor {
  private readonly lmStudio: ManagedService;
  private readonly ollama: ManagedService;

  constructor(private readonly opts: LLMSupervisorOpts) {
    const findLms = opts.findLmsBinary ?? findLmsBinary;
    const findOllama = opts.findOllamaBinary ?? findOllamaBinary;
    const idle = opts.idleShutdownMs ?? DEFAULT_IDLE_SHUTDOWN_MS;
    this.lmStudio = new ManagedService({
      name: 'lm-studio',
      host: '127.0.0.1',
      port: opts.lmStudioPort ?? 1234,
      spawn: opts.spawn,
      healthProbe: opts.lmStudioProbe ?? modelsListProbe,
      idleShutdownMs: idle,
      // `lms server start` daemonizes the server and exits 0 within ~1.5s;
      // without this flag the clean exit read as "died before healthy" and
      // failed the first summarize after every reboot (cold spawn), even as
      // the server it launched came up fine one second later.
      launcherExitsOk: true,
      // LM Studio's CLI startup + GUI handshake is fast (~1–2s),
      // but model load (when an auto-load default is set) can take
      // 10–30s on bigger models.
      startupTimeoutMs: 60_000,
      resolveLaunch: (host, port) => {
        const cmd = findLms();
        return {
          cmd,
          args: ['server', 'start', '--port', String(port)],
        };
      },
      onLog: opts.onLog,
    });
    this.ollama = new ManagedService({
      name: 'ollama',
      host: '127.0.0.1',
      port: opts.ollamaPort ?? 11434,
      spawn: opts.spawn,
      healthProbe: opts.ollamaProbe ?? modelsListProbe,
      idleShutdownMs: idle,
      // `ollama serve` binds the port within a second.
      startupTimeoutMs: 30_000,
      resolveLaunch: (host, port) => {
        const cmd = findOllama();
        return {
          cmd,
          args: ['serve'],
          env: {
            ...process.env,
            OLLAMA_HOST: `${host}:${port}`,
          },
        };
      },
      onLog: opts.onLog,
    });
  }

  /** Wakes the configured provider on demand. No-op when provider
   *  is 'external' (user-managed). For 'lm-studio' also triggers an
   *  `lms load <model>` if the configured model isn't already loaded
   *  in VRAM (LM Studio's `lms server start` brings the OpenAI-compat
   *  server up but doesn't auto-load any model — without this step
   *  the first `chat()` call returns a 404). */
  async ensureReady(): Promise<void> {
    const provider = this.opts.getProvider();
    switch (provider) {
      case 'external':
        return;
      case 'lm-studio':
        await this.lmStudio.ensureReady();
        await this.ensureLmStudioModelLoaded();
        return;
      case 'ollama':
        // Ollama lazy-loads models on first inference — no equivalent
        // step needed. The OpenAI-compat call to /v1/chat/completions
        // triggers the load and the response just takes longer.
        return this.ollama.ensureReady();
    }
  }

  /** Best-effort: load the configured model into VRAM if it isn't
   *  already. Failure is non-fatal — the user might be deliberately
   *  using a different model than `settings.llmModel`, or the model
   *  id might be misspelled. We log and continue; the subsequent
   *  chat() call will surface a clearer error if the model truly
   *  isn't available. */
  private async ensureLmStudioModelLoaded(): Promise<void> {
    const wanted = this.opts.getModelId?.()?.trim();
    if (!wanted) return;
    const host = '127.0.0.1';
    const port = this.opts.lmStudioPort ?? 1234;
    const lister = this.opts.lmsListLoadedModels ?? defaultLmsListLoaded;
    let loaded: string[] = [];
    try {
      loaded = await lister(host, port);
    } catch (e) {
      this.opts.onLog?.(`lm-studio: list-loaded-models failed: ${String(e)}`);
      // Fall through and try to load — worst case the load is a no-op.
    }
    if (loaded.includes(wanted)) return;

    const findLms = this.opts.findLmsBinary ?? findLmsBinary;
    let binary: string;
    try {
      binary = findLms();
    } catch (e) {
      this.opts.onLog?.(`lm-studio: skipping auto-load — ${String(e)}`);
      return;
    }
    const loader = this.opts.lmsLoadModel ?? defaultLmsLoadModel;
    try {
      this.opts.onLog?.(`lm-studio: loading ${wanted}…`);
      await loader(binary, wanted);
      this.opts.onLog?.(`lm-studio: ${wanted} loaded`);
    } catch (e) {
      this.opts.onLog?.(
        `lm-studio: auto-load of ${wanted} failed (${String(e)}). ` +
        'The next chat() call may 404 if the model isn\'t loaded — ' +
        'load it manually via `lms load <model>` or the GUI.',
      );
    }
  }

  /** Stop both managed providers. Called on app shutdown. */
  async stop(): Promise<void> {
    await Promise.all([this.lmStudio.stop(), this.ollama.stop()]);
  }

  /** Stop the OTHER provider when the user switches. Preserves the
   *  invariant that only one of the two is running at a time. */
  async stopOthers(): Promise<void> {
    const provider = this.opts.getProvider();
    const stops: Promise<void>[] = [];
    if (provider !== 'lm-studio') stops.push(this.lmStudio.stop());
    if (provider !== 'ollama') stops.push(this.ollama.stop());
    await Promise.all(stops);
  }
}
