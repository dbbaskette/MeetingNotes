import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { downloadWhisperModel, WHISPER_GGML_BASE } from './download-model.js';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-whisper-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function okResponse(body: string): Response {
  return new Response(body, { status: 200 });
}

describe('downloadWhisperModel', () => {
  it('streams the ggml file to whisper-models/ggml-<model>.bin', async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string) => { seen.push(url); return okResponse('MODELBYTES'); }) as unknown as typeof fetch;
    const { path: dest } = await downloadWhisperModel('medium.en', { dir, fetchImpl });
    expect(seen[0]).toBe(`${WHISPER_GGML_BASE}/ggml-medium.en.bin`);
    expect(dest).toBe(path.join(dir, 'ggml-medium.en.bin'));
    expect(fs.readFileSync(dest, 'utf8')).toBe('MODELBYTES');
    // No leftover .download temp file.
    expect(fs.readdirSync(dir)).toEqual(['ggml-medium.en.bin']);
  });

  it('rejects an invalid model id without touching the network', async () => {
    let called = false;
    const fetchImpl = (async () => { called = true; return okResponse(''); }) as unknown as typeof fetch;
    await expect(downloadWhisperModel('../evil', { dir, fetchImpl })).rejects.toThrow(/invalid model/i);
    expect(called).toBe(false);
  });

  it('gives a clear error and leaves no partial file on a 404', async () => {
    const fetchImpl = (async () => new Response('not found', { status: 404 })) as unknown as typeof fetch;
    await expect(downloadWhisperModel('nope.en', { dir, fetchImpl })).rejects.toThrow(/not found|check the name/i);
    expect(fs.existsSync(path.join(dir, 'ggml-nope.en.bin'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'ggml-nope.en.bin.download'))).toBe(false);
  });
});
