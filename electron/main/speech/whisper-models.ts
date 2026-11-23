import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

// The optional WhisperKit engine (#306): Argmax's compressed Core ML build of
// Whisper large-v3-turbo, plus the Whisper tokenizer it needs. Both come from
// immutable Hub revisions (metadata read 2026-11-23) and every file is checked
// by size and hash. LFS files use SHA-256; regular Git files use Git's blob
// hash (header + bytes).
export const WHISPER_MODEL = 'openai_whisper-large-v3-v20240930_626MB';
export const WHISPER_MODEL_LABEL = 'WhisperKit large-v3-turbo';
export const WHISPER_REVISION = '0f63a7800b00dd0226abd051b906c246e1907482';
export const WHISPER_TOKENIZER_REVISION = '06f233fe06e710322aca913c1bc4249a0d71fce1';
type Source = 'model' | 'tokenizer';
export type ModelFile = [name: string, size: number, hash: string, algorithm: 'sha256' | 'git', source: Source];
const files: ModelFile[] = [
  ['AudioEncoder.mlmodelc/analytics/coremldata.bin', 243, '56793886ab1adb9ca8a4e335efbe8af6640f40d958ab2d29c3ad2d7d6f712e95', 'sha256', 'model'],
  ['AudioEncoder.mlmodelc/coremldata.bin', 348, 'ffa9eb76e8e9d9be75a4d527e5249e61d67fd43081c5aa110fd24efa6c8c5ea3', 'sha256', 'model'],
  ['AudioEncoder.mlmodelc/metadata.json', 1922, '7ecaaec9b1af60d12a5b4701f6a14ba2396ace53', 'git', 'model'],
  ['AudioEncoder.mlmodelc/model.mil', 934263, '0201c413869fdb60610817722f392dc064986105', 'git', 'model'],
  ['AudioEncoder.mlmodelc/weights/weight.bin', 421968768, 'e4740fa28ed65907af754af893dfce98473fafb84dd8d718ad346985fe7678c1', 'sha256', 'model'],
  ['MelSpectrogram.mlmodelc/analytics/coremldata.bin', 243, 'c5be419f8622083ac7046306400643539f0e7577c843448c36defc090d41e7ce', 'sha256', 'model'],
  ['MelSpectrogram.mlmodelc/coremldata.bin', 329, '2bfc12cffc2e45e039c7a18f384f09adffb72c182fcd93f9413d405d1a6c1130', 'sha256', 'model'],
  ['MelSpectrogram.mlmodelc/metadata.json', 1850, 'fa0c2e5993006c311ba50d307cf563ae10a16b5f', 'git', 'model'],
  ['MelSpectrogram.mlmodelc/model.mil', 10143, '16b67b0978ac178a7540e8520915d2473d4bae03', 'git', 'model'],
  ['MelSpectrogram.mlmodelc/weights/weight.bin', 373376, '009d9fb8f6b589accfa08cebf1c712ef07c3405229ce3cfb3a57ee033c9d8a49', 'sha256', 'model'],
  ['TextDecoder.mlmodelc/analytics/coremldata.bin', 243, '3913b8c9716b284a917cf3744f4d415f2a05e2b910594a14c6cc10092284d3f8', 'sha256', 'model'],
  ['TextDecoder.mlmodelc/coremldata.bin', 633, '3faabaf66930e66956d8291d0ff485fb382496e30a91a7185548b9b898ce90a9', 'sha256', 'model'],
  ['TextDecoder.mlmodelc/metadata.json', 4924, '457b227f0ab00cd435c8dfbceb229af8559796af', 'git', 'model'],
  ['TextDecoder.mlmodelc/model.mil', 217177, '1f1a12d6391f6d2d4e98ebaedc88da513460296c', 'git', 'model'],
  ['TextDecoder.mlmodelc/weights/weight.bin', 203199860, 'd69700903d518ada33170ab77faaaf464496fb9ff65752c6d5a6109aa2fb02db', 'sha256', 'model'],
  ['config.json', 1149, 'f6c3db01a3124f90b3bfbf3d58e47ba5de1f5ccd', 'git', 'model'],
  ['generation_config.json', 2767, 'a023f6f947b0fc4ab7a2986a1c23b014836ec720', 'git', 'model'],
  ['tokenizer.json', 2480617, '3a5e2ba63acdcac9a19ba56cf9bd27f185bfff61', 'git', 'tokenizer'],
  ['tokenizer_config.json', 282843, '06ffdc8308eae6bb7bd1fdd81e94b0a881a539ab', 'git', 'tokenizer'],
];
export const WHISPER_DOWNLOAD_BYTES = files.reduce((sum, [, size]) => sum + size, 0);
const MARKER = '.verified.json';
/** What to download and how to recognise a finished install. Tests pass a small one. */
export interface ModelManifest {
  files: readonly ModelFile[];
  url: (name: string, source: Source) => string;
  /** Written into the install record; a record for anything else is not this model. */
  identity: Readonly<Record<string, string | number>>;
}
export const WHISPER_MANIFEST: ModelManifest = {
  files, url: sourceUrl,
  identity: { model: WHISPER_MODEL, revision: WHISPER_REVISION, tokenizerRevision: WHISPER_TOKENIZER_REVISION, files: files.length },
};
const totalBytes = (manifest: ModelManifest): number => manifest.files.reduce((sum, [, size]) => sum + size, 0);

export function whisperModelFolder(home = os.homedir()): string {
  return path.join(home, 'Library', 'Application Support', 'MeetingNotes', 'speech-models', 'whisperkit', WHISPER_REVISION, WHISPER_MODEL);
}
function sourceUrl(name: string, source: Source): string {
  return source === 'model'
    ? `https://huggingface.co/argmaxinc/whisperkit-coreml/resolve/${WHISPER_REVISION}/${WHISPER_MODEL}/${name}`
    : `https://huggingface.co/openai/whisper-large-v3/resolve/${WHISPER_TOKENIZER_REVISION}/${name}`;
}
function hasher(size: number, algorithm: 'sha256' | 'git') {
  const digest = createHash(algorithm === 'git' ? 'sha1' : 'sha256');
  if (algorithm === 'git') digest.update(`blob ${size}\0`);
  return digest;
}
function plainFileOfSize(file: string, size: number): boolean {
  try { const stat = fs.lstatSync(file); return stat.isFile() && !stat.isSymbolicLink() && stat.size === size; } catch { return false; }
}
/** Streams the file through its hash; a 422 MB weight file is never held in memory. */
async function fileMatches(file: string, size: number, hash: string, algorithm: 'sha256' | 'git', signal?: AbortSignal,
  onBytes?: (count: number) => void): Promise<boolean> {
  if (!plainFileOfSize(file, size)) return false;
  const digest = hasher(size, algorithm);
  for await (const chunk of fs.createReadStream(file, { signal })) { digest.update(chunk as Buffer); onBytes?.((chunk as Buffer).length); }
  return digest.digest('hex') === hash;
}

/**
 * Cheap enough to call on every status check: the files were hashed when they
 * were installed, so here it is the install record plus each file's presence,
 * type and exact size. `installWhisperModels` re-hashes everything.
 */
export function whisperModelsReady(folder: string, manifest: ModelManifest = WHISPER_MANIFEST): boolean {
  try {
    if (fs.lstatSync(folder).isSymbolicLink()) return false;
    const recorded = JSON.parse(fs.readFileSync(path.join(folder, MARKER), 'utf8')) as Record<string, unknown>;
    if (Object.entries(manifest.identity).some(([key, value]) => recorded[key] !== value)) return false;
    return manifest.files.every(([name, size]) => plainFileOfSize(path.join(folder, name), size));
  } catch { return false; }
}

async function allFilesMatch(folder: string, manifest: ModelManifest, signal: AbortSignal, progress: (fraction: number) => void): Promise<boolean> {
  let done = 0;
  const total = totalBytes(manifest);
  for (const [name, size, hash, algorithm] of manifest.files) {
    signal.throwIfAborted();
    if (!await fileMatches(path.join(folder, name), size, hash, algorithm, signal, count => { done += count; progress(done / total); })) return false;
  }
  return true;
}

/**
 * Download (or re-verify) the model. Files that finished downloading are kept
 * in a staging folder, so a cancelled or failed download resumes at the next
 * file instead of starting over. Nothing is installed until every hash matches.
 */
export async function installWhisperModels(folder: string, signal: AbortSignal, progress: (fraction: number) => void,
  fetcher: typeof fetch = fetch, manifest: ModelManifest = WHISPER_MANIFEST): Promise<void> {
  const parent = path.dirname(folder);
  const total = totalBytes(manifest);
  const record = (): string => JSON.stringify({ ...manifest.identity, verifiedAt: new Date().toISOString() });
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (fs.existsSync(folder)) {
    // Already installed: "Prepare" doubles as an explicit integrity check.
    if (await allFilesMatch(folder, manifest, signal, progress)) {
      fs.writeFileSync(path.join(folder, MARKER), record());
      progress(1); return;
    }
    // Move it out of the way first so the name is free even if removal
    // fails, then drop it: a damaged 627 MB copy is not worth keeping.
    const invalid = `${folder}.invalid-${Date.now()}`;
    fs.renameSync(folder, invalid);
    fs.rmSync(invalid, { recursive: true, force: true });
  }
  const staging = path.join(parent, `.download-${path.basename(folder)}`);
  fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
  let completed = 0;
  const pending: ModelFile[] = [];
  for (const entry of manifest.files) {
    signal.throwIfAborted();
    const [name, size, hash, algorithm] = entry;
    if (await fileMatches(path.join(staging, name), size, hash, algorithm, signal)) { completed += size; progress(completed / total); }
    else pending.push(entry);
  }
  const needed = pending.reduce((sum, [, size]) => sum + size, 0);
  const disk = fs.statfsSync(parent);
  if (disk.bavail * disk.bsize < needed + 500 * 1024 * 1024) {
    throw new Error(`Free at least ${((needed + 500 * 1024 * 1024) / 1024 ** 3).toFixed(1)} GB to download the WhisperKit model.`);
  }
  for (const [name, size, hash, algorithm, source] of pending) {
    signal.throwIfAborted();
    const target = path.join(staging, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.rmSync(target, { force: true });
    const response = await fetcher(manifest.url(name, source), { signal, credentials: 'omit' });
    if (!response.ok || !response.body) throw new Error(`Model download failed (${response.status}). Retry while online.`);
    const digest = hasher(size, algorithm);
    const out = fs.createWriteStream(target, { flags: 'wx', mode: 0o600 });
    // Without a listener a late open/write failure would be an uncaught exception.
    let writeError: Error | undefined;
    out.on('error', error => { writeError ??= error; });
    let received = 0;
    try {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        signal.throwIfAborted();
        if (writeError) throw writeError;
        received += chunk.length;
        if (received > size) throw new Error('Model download exceeded the expected size.');
        digest.update(chunk);
        // Wait for the disk when it falls behind the network. One listener
        // pair per wait, removed again, however large the file is.
        if (!out.write(chunk)) await new Promise<void>(resolve => {
          const done = (): void => { out.off('drain', done); out.off('error', done); resolve(); };
          out.once('drain', done); out.once('error', done);
        });
        progress((completed + received) / total);
      }
      await new Promise<void>(resolve => out.end(() => resolve()));
      if (writeError) throw writeError;
      if (received !== size || digest.digest('hex') !== hash) throw new Error('Model integrity verification failed. Retry the download.');
    } catch (error) {
      // Never leave a partial or unverified file where the next attempt would trust it.
      await new Promise<void>(resolve => { if (out.closed) resolve(); else { out.once('close', () => resolve()); out.destroy(); } });
      fs.rmSync(target, { force: true });
      throw error;
    }
    completed += size;
  }
  signal.throwIfAborted();
  fs.writeFileSync(path.join(staging, MARKER), record());
  fs.renameSync(staging, folder);
  progress(1);
}
