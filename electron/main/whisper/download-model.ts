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
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { modelsDir } from './supervisor.js';

/** Same host the shell script falls back to (scripts/whisper-server.sh). */
export const WHISPER_GGML_BASE = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';

/** Allow only bare model ids like `medium.en` / `large-v3-turbo` — never a
 *  path fragment — so the id can't escape the models directory or the URL. */
const MODEL_ID = /^[a-z0-9][a-z0-9.\-]*$/i;

export interface DownloadOpts {
  /** Override the destination dir (tests). Defaults to the app's models dir. */
  dir?: string;
  /** Injectable fetch (tests). */
  fetchImpl?: typeof fetch;
}

/** Download ggml-<model>.bin into the whisper-models directory and return its
 *  path. Writes to a `.download` temp file and renames on success so a failed
 *  or interrupted download never leaves a truncated file that looks installed. */
export async function downloadWhisperModel(
  model: string,
  opts: DownloadOpts = {},
): Promise<{ path: string }> {
  if (typeof model !== 'string' || !MODEL_ID.test(model)) {
    throw new Error(`invalid model id: ${String(model)}`);
  }
  const doFetch = opts.fetchImpl ?? fetch;
  const dir = opts.dir ?? modelsDir();
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `ggml-${model}.bin`);
  const tmp = `${dest}.download`;

  const res = await doFetch(`${WHISPER_GGML_BASE}/ggml-${model}.bin`);
  if (!res.ok || !res.body) {
    throw new Error(
      res.status === 404
        ? `Whisper model "${model}" not found on the model host — check the name.`
        : `Whisper model download failed for "${model}" (HTTP ${res.status}).`,
    );
  }
  try {
    await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), fs.createWriteStream(tmp));
    fs.renameSync(tmp, dest);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best-effort cleanup */ }
    throw e;
  }
  return { path: dest };
}
