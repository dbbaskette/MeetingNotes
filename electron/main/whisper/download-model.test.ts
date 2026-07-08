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
    // No stray unique tmp files either.
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.download'))).toEqual([]);
  });

  it('reports progress with cumulative bytes and a final call where received === total', async () => {
    const chunks = ['AAAA', 'BBBB', 'CC'];
    const totalBytes = chunks.join('').length;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
        controller.close();
      },
    });
    const fetchImpl = (async () => new Response(body, {
      status: 200,
      headers: { 'content-length': String(totalBytes) },
    })) as unknown as typeof fetch;

    const calls: Array<[number, number | null]> = [];
    await downloadWhisperModel('tiny.en', {
      dir, fetchImpl, onProgress: (received, total) => calls.push([received, total]),
    });
    expect(calls.length).toBeGreaterThanOrEqual(1);
    // Cumulative, never decreasing.
    for (let i = 1; i < calls.length; i++) {
      expect(calls[i]![0]).toBeGreaterThanOrEqual(calls[i - 1]![0]);
    }
    // Every call carries the parsed content-length; final call is complete.
    expect(calls.every(([, total]) => total === totalBytes)).toBe(true);
    expect(calls[calls.length - 1]![0]).toBe(totalBytes);
  });

  it('passes total=null when content-length is absent', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('DATA'));
        controller.close();
      },
    });
    // Response(body) would normally infer no content-length for streams.
    const fetchImpl = (async () => new Response(body, { status: 200 })) as unknown as typeof fetch;
    const calls: Array<[number, number | null]> = [];
    await downloadWhisperModel('tiny', {
      dir, fetchImpl, onProgress: (received, total) => calls.push([received, total]),
    });
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls.every(([, total]) => total === null)).toBe(true);
    expect(calls[calls.length - 1]![0]).toBe(4);
  });

  it('dedups concurrent downloads of the same model (fetch invoked once)', async () => {
    let fetchCount = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const fetchImpl = (async () => {
      fetchCount += 1;
      await gate; // hold the first download in flight
      return okResponse('MODELBYTES');
    }) as unknown as typeof fetch;

    const p1 = downloadWhisperModel('base.en', { dir, fetchImpl });
    const p2 = downloadWhisperModel('base.en', { dir, fetchImpl });
    release();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(fetchCount).toBe(1);
    expect(r1.path).toBe(r2.path);
    expect(fs.readFileSync(r1.path, 'utf8')).toBe('MODELBYTES');

    // After settling, a fresh call re-downloads (the guard is in-flight only).
    await downloadWhisperModel('base.en', { dir, fetchImpl });
    expect(fetchCount).toBe(2);
  });
});
