import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { installWhisperModels, whisperModelsReady, whisperModelFolder, WHISPER_MANIFEST, WHISPER_DOWNLOAD_BYTES,
  WHISPER_MODEL, WHISPER_REVISION, type ModelManifest, type ModelFile } from './whisper-models.js';

const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex');
const gitBlob = (data: Buffer): string => createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex');
const contents: Record<string, Buffer> = {
  'Encoder.mlmodelc/weights/weight.bin': Buffer.alloc(300_000, 7),
  'Encoder.mlmodelc/model.mil': Buffer.from('program(1.0)'),
  'tokenizer.json': Buffer.from('{"version":"1.0"}'),
};
const entries: ModelFile[] = [
  ['Encoder.mlmodelc/weights/weight.bin', 300_000, sha256(contents['Encoder.mlmodelc/weights/weight.bin']!), 'sha256', 'model'],
  ['Encoder.mlmodelc/model.mil', contents['Encoder.mlmodelc/model.mil']!.length, gitBlob(contents['Encoder.mlmodelc/model.mil']!), 'git', 'model'],
  ['tokenizer.json', contents['tokenizer.json']!.length, gitBlob(contents['tokenizer.json']!), 'git', 'tokenizer'],
];
const manifest: ModelManifest = { files: entries, url: (name, source) => `https://models.invalid/${source}/${name}`, identity: { model: 'fixture', revision: 'r1' } };

let root: string, folder: string, served: Record<string, Buffer>, requests: string[];
const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input); requests.push(url);
  const name = url.replace(/^https:\/\/models\.invalid\/(?:model|tokenizer)\//, '');
  const body = served[name];
  if (!body) return new Response('missing', { status: 404 });
  // Several chunks, so cancelling mid-file and size limits are exercised.
  const stream = new ReadableStream<Uint8Array>({ start(controller) {
    for (let offset = 0; offset < body.length; offset += 64_000) controller.enqueue(body.subarray(offset, offset + 64_000));
    controller.close();
  } });
  init?.signal?.throwIfAborted();
  return new Response(stream, { status: 200 });
}) as unknown as typeof fetch;
const install = (signal = new AbortController().signal, progress: (fraction: number) => void = () => {}) =>
  installWhisperModels(folder, signal, progress, fetcher, manifest);
const staging = (): string => path.join(root, `.download-${path.basename(folder)}`);

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-whisper-models-'));
  folder = path.join(root, 'fixture-model'); served = { ...contents }; requests = [];
});
afterEach(() => { vi.clearAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

it('downloads every file, verifies it and only then installs the folder', async () => {
  const fractions: number[] = [];
  expect(whisperModelsReady(folder, manifest)).toBe(false);
  await install(undefined, fraction => fractions.push(fraction));
  expect(whisperModelsReady(folder, manifest)).toBe(true);
  for (const [name] of entries) expect(fs.readFileSync(path.join(folder, name))).toEqual(contents[name]);
  expect(requests).toEqual(['https://models.invalid/model/Encoder.mlmodelc/weights/weight.bin', 'https://models.invalid/model/Encoder.mlmodelc/model.mil', 'https://models.invalid/tokenizer/tokenizer.json']);
  expect(fractions.at(-1)).toBe(1);
  expect(fractions.every((value, index) => value >= 0 && value <= 1 && (index === 0 || value >= fractions[index - 1]!))).toBe(true);
  expect(fs.existsSync(staging())).toBe(false);
  // Requests carry no credentials.
  expect((fetcher as unknown as ReturnType<typeof vi.fn>).mock.calls.every(call => (call[1] as RequestInit).credentials === 'omit')).toBe(true);
});

it('rejects a file whose bytes do not match and installs nothing', async () => {
  served['Encoder.mlmodelc/model.mil'] = Buffer.from('program(9.9)');
  await expect(install()).rejects.toThrow('integrity verification failed');
  expect(fs.existsSync(folder)).toBe(false);
  expect(whisperModelsReady(folder, manifest)).toBe(false);
  // The bad file is not left where the next attempt would trust it.
  expect(fs.existsSync(path.join(staging(), 'Encoder.mlmodelc/model.mil'))).toBe(false);
});

it('stops a download that is larger than the pinned size', async () => {
  served['tokenizer.json'] = Buffer.alloc(200_000, 1);
  await expect(install()).rejects.toThrow('exceeded the expected size');
  expect(fs.existsSync(path.join(staging(), 'tokenizer.json'))).toBe(false);
  expect(fs.existsSync(folder)).toBe(false);
});

it('reports a failed request with its status', async () => {
  delete served['tokenizer.json'];
  await expect(install()).rejects.toThrow('Model download failed (404)');
});

it('keeps finished files after a failure, so a retry downloads only what is missing', async () => {
  delete served['tokenizer.json'];
  await expect(install()).rejects.toThrow('404');
  expect(fs.existsSync(path.join(staging(), 'Encoder.mlmodelc/weights/weight.bin'))).toBe(true);
  served = { ...contents }; requests = [];
  await install();
  expect(requests).toEqual(['https://models.invalid/tokenizer/tokenizer.json']);
  expect(whisperModelsReady(folder, manifest)).toBe(true);
});

it('does not start when setup was already cancelled', async () => {
  const controller = new AbortController(); controller.abort();
  await expect(install(controller.signal)).rejects.toThrow();
  expect(requests).toEqual([]);
  expect(fs.existsSync(folder)).toBe(false);
});

it('cancels in the middle of a file and leaves no partial file behind', async () => {
  const controller = new AbortController();
  await expect(install(controller.signal, fraction => { if (fraction > 0.3) controller.abort(); })).rejects.toThrow();
  expect(fs.existsSync(folder)).toBe(false);
  expect(fs.existsSync(path.join(staging(), 'Encoder.mlmodelc/weights/weight.bin'))).toBe(false);
});

it('is not ready when a file is missing, resized, a link, or recorded for another revision', async () => {
  await install();
  const weights = path.join(folder, 'Encoder.mlmodelc/weights/weight.bin');
  fs.appendFileSync(weights, 'x');
  expect(whisperModelsReady(folder, manifest)).toBe(false);
  fs.writeFileSync(weights, contents['Encoder.mlmodelc/weights/weight.bin']!);
  expect(whisperModelsReady(folder, manifest)).toBe(true);
  expect(whisperModelsReady(folder, { ...manifest, identity: { model: 'fixture', revision: 'r2' } })).toBe(false);
  const tokenizer = path.join(folder, 'tokenizer.json');
  fs.rmSync(tokenizer); fs.symlinkSync(path.join(folder, 'Encoder.mlmodelc/model.mil'), tokenizer);
  expect(whisperModelsReady(folder, manifest)).toBe(false);
  fs.rmSync(tokenizer);
  expect(whisperModelsReady(folder, manifest)).toBe(false);
  fs.rmSync(path.join(folder, '.verified.json'));
  expect(whisperModelsReady(folder, manifest)).toBe(false);
});

it('re-hashes an installed model without downloading when asked to prepare again', async () => {
  await install(); requests = [];
  fs.rmSync(path.join(folder, '.verified.json'));
  await install();
  expect(requests).toEqual([]);
  expect(whisperModelsReady(folder, manifest)).toBe(true);
});

it('replaces a tampered install with a clean download and does not keep the damaged copy', async () => {
  await install(); requests = [];
  // Same size, different bytes: only a hash can tell.
  fs.writeFileSync(path.join(folder, 'Encoder.mlmodelc/weights/weight.bin'), Buffer.alloc(300_000, 8));
  expect(whisperModelsReady(folder, manifest)).toBe(true);
  await install();
  expect(requests).toHaveLength(3);
  expect(fs.readFileSync(path.join(folder, 'Encoder.mlmodelc/weights/weight.bin'))).toEqual(contents['Encoder.mlmodelc/weights/weight.bin']);
  expect(fs.readdirSync(root)).toEqual(['fixture-model']);
});

it('pins the real model: immutable revisions, hashes for every file and the tokenizer it needs', () => {
  expect(WHISPER_REVISION).toMatch(/^[a-f0-9]{40}$/);
  expect(WHISPER_DOWNLOAD_BYTES).toBeGreaterThan(600e6);
  expect(WHISPER_DOWNLOAD_BYTES).toBeLessThan(700e6);
  const names = WHISPER_MANIFEST.files.map(([name]) => name);
  for (const required of ['AudioEncoder.mlmodelc/weights/weight.bin', 'MelSpectrogram.mlmodelc/model.mil', 'TextDecoder.mlmodelc/weights/weight.bin', 'config.json', 'tokenizer.json'])
    expect(names).toContain(required);
  expect(new Set(names).size).toBe(names.length);
  for (const [name, size, hash, algorithm, source] of WHISPER_MANIFEST.files) {
    expect(name.startsWith('/') || name.includes('..')).toBe(false);
    expect(size).toBeGreaterThan(0);
    expect(hash).toMatch(algorithm === 'sha256' ? /^[a-f0-9]{64}$/ : /^[a-f0-9]{40}$/);
    const url = WHISPER_MANIFEST.url(name, source);
    expect(url).toMatch(/^https:\/\/huggingface\.co\/(argmaxinc\/whisperkit-coreml|openai\/whisper-large-v3)\/resolve\/[a-f0-9]{40}\//);
    expect(url).not.toMatch(/resolve\/main/);
  }
  expect(whisperModelFolder('/Users/fixture')).toBe(`/Users/fixture/Library/Application Support/MeetingNotes/speech-models/whisperkit/${WHISPER_REVISION}/${WHISPER_MODEL}`);
});
