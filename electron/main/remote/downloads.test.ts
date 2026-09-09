import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DurableDownload, type DownloadIdentity } from './downloads.js';
import { canonical, digest, RemoteClient } from './client.js';
import type { RemoteCreateJob } from '../../../shared/remote-contracts.js';

const dirs: string[] = [];
const root = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-download-test-')); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const bytes = Buffer.from(JSON.stringify({ summary: 'Synthetic partial download recovery.', actionItems: [] }));
function identity(): DownloadIdentity { return { endpoint: 'https://api.example', jobId: randomUUID(), runId: randomUUID(),
  requestDigest: 'a'.repeat(64), manifestDigest: 'b'.repeat(64), name: 'text', bytes: bytes.length, sha256: digest(bytes) }; }
function interrupted(prefix = bytes.subarray(0, 12)): Response {
  let sent = false;
  return new Response(new ReadableStream({ pull(controller) {
    if (!sent) { sent = true; controller.enqueue(prefix); }
    else controller.error(new Error('connection interrupted'));
  } }));
}
function suffix(offset: number, contentRange = `bytes ${offset}-${bytes.length - 1}/${bytes.length}`): Response {
  return new Response(new Uint8Array(bytes.subarray(offset)), { status: 206,
    headers: { 'Content-Range': contentRange, 'Content-Length': String(bytes.length - offset) } });
}

describe('durable artifact download checkpoints', () => {
  it('fsyncs a prefix and resumes with Range after reopen; incomplete responses retain the checkpoint', async () => {
    const dir = root(), pin = identity(), first = new DurableDownload(dir, pin);
    await expect(first.consume(interrupted())).rejects.toThrow('connection interrupted');
    const reopened = new DurableDownload(dir, pin);
    expect(reopened.headers().Range).toBe('bytes=12-');
    const result = await reopened.consume(suffix(12)); expect(result).toEqual(bytes);
    expect(new DurableDownload(dir, pin).complete()).toEqual(bytes);
  });
  it('truncates an appended but uncommitted tail on reopen before asking for the durable offset', async () => {
    const dir = root(), pin = identity(), first = new DurableDownload(dir, pin);
    await expect(first.consume(interrupted())).rejects.toThrow();
    fs.appendFileSync(first.partialPath, bytes.subarray(12, 17));
    const reopened = new DurableDownload(dir, pin);
    expect(fs.statSync(reopened.partialPath).size).toBe(12); expect(reopened.headers().Range).toBe('bytes=12-');
    expect(await reopened.consume(suffix(12))).toEqual(bytes);
  });
  it('replaces the partial representation when the server ignores Range with 200', async () => {
    const dir = root(), pin = identity(), first = new DurableDownload(dir, pin);
    await expect(first.consume(interrupted())).rejects.toThrow();
    const reopened = new DurableDownload(dir, pin);
    expect(await reopened.consume(new Response(new Uint8Array(bytes), { headers: { 'Content-Length': String(bytes.length) } }))).toEqual(bytes);
    expect(fs.statSync(reopened.partialPath).size).toBe(bytes.length);
  });
  it.each(['before', 'after'] as const)('recovers a crash %s truncation during HTTP-200 fallback', async crashAt => {
    const dir = root(), pin = identity(), first = new DurableDownload(dir, pin);
    await expect(first.consume(interrupted())).rejects.toThrow();
    const resumed = new DurableDownload(dir, pin), truncate = fs.ftruncateSync;
    const fault = vi.spyOn(fs, 'ftruncateSync').mockImplementationOnce((fd, length) => {
      if (crashAt === 'after') { truncate(fd, length); fs.fsyncSync(fd); }
      throw new Error('simulated fallback crash');
    });
    try {
      await expect(resumed.consume(new Response(new Uint8Array(bytes)))).rejects.toThrow('simulated fallback crash');
    } finally { fault.mockRestore(); }
    expect(fs.statSync(resumed.partialPath).size).toBe(crashAt === 'after' ? 0 : 12);
    // The reset checkpoint must already be durable in either crash window.
    const recovered = new DurableDownload(dir, pin);
    expect(recovered.headers().Range).toBeUndefined();
    expect(fs.statSync(recovered.partialPath).size).toBe(0);
    expect(await recovered.consume(new Response(new Uint8Array(bytes)))).toEqual(bytes);
    expect(new DurableDownload(dir, pin).complete()).toEqual(bytes);
  });
  it.each(['bytes 0-20/21', 'bytes 13-74/75', 'bytes 12-99/*', 'garbage'])('rejects invalid Content-Range %s without appending', async range => {
    const dir = root(), pin = identity(), first = new DurableDownload(dir, pin);
    await expect(first.consume(interrupted())).rejects.toThrow();
    const reopened = new DurableDownload(dir, pin);
    await expect(reopened.consume(suffix(12, range))).rejects.toThrow('INVALID_CONTENT_RANGE');
    expect(fs.readFileSync(reopened.partialPath)).toEqual(bytes.subarray(0, 12));
  });
  it('rejects identity changes and corrupted prefixes instead of reusing another artifact', async () => {
    const dir = root(), pin = identity(), first = new DurableDownload(dir, pin);
    await expect(first.consume(interrupted())).rejects.toThrow();
    for (const patch of [{ jobId: randomUUID() }, { runId: randomUUID() }, { endpoint: 'https://other.example' }, { requestDigest: 'c'.repeat(64) }, { sha256: 'd'.repeat(64) }]) {
      expect(() => new DurableDownload(dir, { ...pin, ...patch })).toThrow('INVALID_DOWNLOAD_CHECKPOINT');
    }
    fs.writeFileSync(first.partialPath, Buffer.alloc(12, 0)); expect(() => new DurableDownload(dir, pin)).toThrow('INVALID_DOWNLOAD_CHECKPOINT');
  });
  it('rejects overlong bodies and validates the final raw SHA-256', async () => {
    await expect(new DurableDownload(root(), identity()).consume(new Response(new Uint8Array(Buffer.alloc(bytes.length + 1))))).rejects.toThrow('RESPONSE_TOO_LARGE');
    await expect(new DurableDownload(root(), identity()).consume(new Response(new Uint8Array(Buffer.alloc(bytes.length))))).rejects.toThrow('ARTIFACT_HASH_MISMATCH');
  });
  it('renews signed URLs across client recreation and still checks final artifact schema', async () => {
    const dir = root(), pin = identity();
    const request: RemoteCreateJob = { schemaVersion: 1, clientMeetingId: 'opaque', clientRunId: pin.runId, kind: 'text_generation',
      profileId: 'profile', profileDigest: 'a'.repeat(64), source: { bytes: 1, sha256: 'c'.repeat(64), contentType: 'application/json' } };
    const manifest = { schemaVersion: 1, jobId: pin.jobId, clientRunId: pin.runId, profileId: request.profileId, profileDigest: request.profileDigest, generation: 1,
      artifacts: [{ name: 'text', bytes: bytes.length, sha256: digest(bytes), contentType: 'application/json' }] };
    let attempt = 0; const seenRanges: (string | null)[] = [];
    const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/result')) return new Response(JSON.stringify({ manifest, manifestDigest: digest(canonical(manifest)),
        downloads: [{ name: 'text', url: `https://objects.example/artifact?signature=${attempt}`, expiresAt: new Date(Date.now() + 60000).toISOString() }] }));
      expect(new Headers(init?.headers).has('Authorization')).toBe(false);
      seenRanges.push(new Headers(init?.headers).get('Range'));
      return attempt++ === 0 ? interrupted() : suffix(12);
    }) as typeof fetch;
    const client = () => new RemoteClient(pin.endpoint, () => 'synthetic-test-token', new AbortController().signal, false, fetcher);
    await expect(client().result(pin.jobId, request, dir)).rejects.toThrow('connection interrupted');
    expect((await client().result(pin.jobId, request, dir)).artifacts.text).toEqual(bytes); expect(seenRanges).toEqual([null, 'bytes=12-']);
    // A different immutable manifest gets a separate fixed directory, not this prefix.
    const invalidBytes = Buffer.from(JSON.stringify({ summary: 42, actionItems: [] }));
    manifest.artifacts[0]!.bytes = invalidBytes.length; manifest.artifacts[0]!.sha256 = digest(invalidBytes);
    const invalidFetcher = (async (url: string | URL | Request, init?: RequestInit) => String(url).endsWith('/result') ? fetcher(url, init) : new Response(new Uint8Array(invalidBytes))) as typeof fetch;
    await expect(new RemoteClient(pin.endpoint, () => 'synthetic-test-token', new AbortController().signal, false, invalidFetcher).result(pin.jobId, request, dir)).rejects.toThrow('INVALID_ARTIFACT');
  });
});
