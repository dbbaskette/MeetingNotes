// electron/main/whisper/download-model.ts
//
// Native ggml-model download for the onboarding "Download <model>" button.
// Replaces the old shell-out to scripts/whisper-server.sh, which only worked
// in dev — the scripts aren't bundled into the packaged .app, so the button
// failed with "bash: scripts/whisper-server.sh: No such file or directory".
// Mirrors the script's Hugging Face fallback: pull ggml-<model>.bin straight
// into the app's whisper-models directory, streamed to disk so a 1.5 GB model
// never sits in memory.
import fs from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { modelsDir } from './supervisor.js';

/** Same host the shell script falls back to (scripts/whisper-server.sh). */
export const WHISPER_GGML_BASE = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';

/** Allow only bare model ids like `medium.en` / `large-v3-turbo` — never a
 *  path fragment — so the id can't escape the models directory or the URL. */
const MODEL_ID = /^[a-z0-9][a-z0-9.\-]*$/i;

/** Progress callbacks are throttled to roughly this cadence so a fast
 *  connection doesn't spam IPC with per-chunk updates. */
const PROGRESS_INTERVAL_MS = 250;

export interface DownloadOpts {
  /** Override the destination dir (tests). Defaults to the app's models dir. */
  dir?: string;
  /** Injectable fetch (tests). */
  fetchImpl?: typeof fetch;
  /** Byte-level progress. `total` is the parsed content-length, or null when
   *  the host didn't send one. Throttled to ~4 calls/sec, plus one final
   *  call on completion where `received` is the full byte count. */
  onProgress?: (received: number, total: number | null) => void;
}

/** In-flight downloads by model id. A second install click (or a second
 *  window) while a model is still downloading joins the existing promise
 *  instead of racing a concurrent write to the same destination file. */
const inflight = new Map<string, Promise<{ path: string }>>();

/** Download ggml-<model>.bin into the whisper-models directory and return its
 *  path. Writes to a unique temp file and renames on success so a failed or
 *  interrupted download never leaves a truncated file that looks installed.
 *  Concurrent calls for the same model share one download. */
export async function downloadWhisperModel(
  model: string,
  opts: DownloadOpts = {},
): Promise<{ path: string }> {
  if (typeof model !== 'string' || !MODEL_ID.test(model)) {
    throw new Error(`invalid model id: ${String(model)}`);
  }
  const existing = inflight.get(model);
  if (existing) return existing;
  const job = doDownload(model, opts).finally(() => { inflight.delete(model); });
  inflight.set(model, job);
  return job;
}

async function doDownload(
  model: string,
  opts: DownloadOpts,
): Promise<{ path: string }> {
  const doFetch = opts.fetchImpl ?? fetch;
  const dir = opts.dir ?? modelsDir();
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `ggml-${model}.bin`);
  // Unique per attempt — defense in depth against two processes (or a
  // crashed leftover) sharing one temp path and corrupting each other.
  const tmp = `${dest}.${process.pid}.${Date.now()}.download`;

  const res = await doFetch(`${WHISPER_GGML_BASE}/ggml-${model}.bin`);
  if (!res.ok || !res.body) {
    throw new Error(
      res.status === 404
        ? `Whisper model "${model}" not found on the model host — check the name.`
        : `Whisper model download failed for "${model}" (HTTP ${res.status}).`,
    );
  }

  const contentLength = res.headers.get('content-length');
  const parsedTotal = contentLength === null ? NaN : Number(contentLength);
  const total = Number.isFinite(parsedTotal) && parsedTotal >= 0 ? parsedTotal : null;

  let received = 0;
  let lastProgressAt = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      received += chunk.length;
      const now = Date.now();
      if (opts.onProgress && now - lastProgressAt >= PROGRESS_INTERVAL_MS) {
        lastProgressAt = now;
        opts.onProgress(received, total);
      }
      cb(null, chunk);
    },
  });

  try {
    await pipeline(
      Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
      counter,
      fs.createWriteStream(tmp),
    );
    fs.renameSync(tmp, dest);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best-effort cleanup */ }
    throw e;
  }
  // Final progress tick — guarantees the UI lands on 100% / the true size
  // even when the throttle swallowed the last chunk's update.
  opts.onProgress?.(received, total);
  return { path: dest };
}
