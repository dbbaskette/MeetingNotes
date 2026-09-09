import fs from 'node:fs';
import { createHash } from 'node:crypto';
import type { z } from 'zod';
import { DurableDownload, DownloadError } from './downloads.js';
import {
  RemoteCapabilitiesSchema, RemoteJobSchema, RemoteUploadSchema, RemoteUploadUrlsSchema,
  RemoteResultSchema, RemoteErrorSchema, RemoteTranscriptionSchema, RemoteDiarizationSchema,
  RemoteTextResultSchema, type RemoteCreateJob, type RemoteResult,
} from '../../../shared/remote-contracts.js';

export function endpointUrl(value: string, allowLoopback = false): string {
  const url = safeTransferUrl(value, allowLoopback);
  if (url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) throw new Error('Server URL must be an origin, without a path');
  return url.origin;
}
export function safeTransferUrl(value: string, allowLoopback = false): URL {
  const url = new URL(value);
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.hash || (url.protocol !== 'https:' && !(allowLoopback && loopback && url.protocol === 'http:'))) {
    throw new Error('Remote transfers require HTTPS');
  }
  return url;
}
export function digest(value: Buffer | string): string { return createHash('sha256').update(value).digest('hex'); }
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export async function hashFile(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
export class RemoteClientError extends Error {
  constructor(readonly code: string, readonly retryable: boolean, readonly retryAfterMs = 0) { super(code); }
}
async function bounded(response: Response, max: number): Promise<Buffer> {
  if (Number(response.headers.get('content-length')) > max) throw new RemoteClientError('RESPONSE_TOO_LARGE', false);
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Buffer[] = []; let total = 0;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      total += part.value.byteLength;
      if (total > max) throw new RemoteClientError('RESPONSE_TOO_LARGE', false);
      chunks.push(Buffer.from(part.value));
    }
    return Buffer.concat(chunks);
  } finally { await reader.cancel().catch(() => {}); }
}
export class RemoteClient {
  constructor(readonly endpoint: string, private token: () => string, private signal: AbortSignal,
    private allowLoopback = false, private fetcher: typeof fetch = fetch) { endpointUrl(endpoint, allowLoopback); }
  private async response<T>(url: string, init: RequestInit, consume: (response: Response) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const stop = () => controller.abort(); this.signal.addEventListener('abort', stop, { once: true });
    if (this.signal.aborted) stop();
    const timer = setTimeout(stop, 60_000);
    try {
      const response = await this.fetcher(safeTransferUrl(url, this.allowLoopback), { ...init, redirect: 'error', signal: controller.signal });
      if (!response.ok) {
        const bytes = await bounded(response, 100_000);
        let code = `HTTP_${response.status}`, retryable = response.status === 429 || response.status >= 500;
        try { const parsed = RemoteErrorSchema.parse(JSON.parse(bytes.toString())); code = parsed.error.code; retryable = parsed.error.retryable; } catch { /* no provider body in errors */ }
        const retry = response.headers.get('retry-after');
        const delay = retry ? (/^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now()) : 0;
        throw new RemoteClientError(code, retryable, Math.min(60_000, Math.max(0, delay || 0)));
      }
      try { return await consume(response); }
      finally { await response.body?.cancel().catch(() => {}); }
    } finally { clearTimeout(timer); this.signal.removeEventListener('abort', stop); }
  }
  private request(url: string, init: RequestInit, max: number): Promise<Buffer> {
    return this.response(url, init, response => bounded(response, max));
  }
  async control<T>(route: string, schema: z.ZodType<T>, method = 'GET', body?: unknown, key?: string): Promise<T> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.token()}` };
    if (key) headers['Idempotency-Key'] = key;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const bytes = await this.request(`${this.endpoint}/v1${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }, 100_000);
    try { return schema.parse(JSON.parse(bytes.toString())); } catch { throw new RemoteClientError('INVALID_SERVER_RESPONSE', false); }
  }
  capabilities() { return this.control('/capabilities', RemoteCapabilitiesSchema); }
  create(request: RemoteCreateJob) { return this.control('/jobs', RemoteJobSchema, 'POST', request, `${request.clientRunId}_create`); }
  job(id: string) { return this.control(`/jobs/${id}`, RemoteJobSchema); }
  upload(id: string) { return this.control(`/jobs/${id}/upload`, RemoteUploadSchema); }
  complete(id: string, run: string) { return this.control(`/jobs/${id}/upload-completion`, RemoteJobSchema, 'POST', {}, `${run}_complete`); }
  cancel(id: string, run: string) { return this.control(`/jobs/${id}/cancellation`, RemoteJobSchema, 'POST', {}, `${run}_cancel`); }
  async remove(id: string, run: string): Promise<void> {
    await this.request(`${this.endpoint}/v1/jobs/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${this.token()}`, 'Idempotency-Key': `${run}_delete` } }, 100_000);
  }
  ack(id: string, run: string, manifestDigest: string) { return this.control(`/jobs/${id}/acknowledgements`, RemoteJobSchema, 'POST', { manifestDigest }, `${run}_ack`); }
  async uploadPart(id: string, run: string, number: number, bytes: Buffer): Promise<void> {
    const urls = await this.control(`/jobs/${id}/upload-parts`, RemoteUploadUrlsSchema, 'POST', { partNumbers: [number] }, `${run}_part_${number}`);
    if (urls.parts.length !== 1 || urls.parts[0]!.partNumber !== number) throw new RemoteClientError('INVALID_UPLOAD_PART', false);
    await this.request(urls.parts[0]!.url, { method: 'PUT', headers: { 'Content-Length': String(bytes.length) }, body: new Uint8Array(bytes) }, 100_000);
  }
  async result(id: string, request: RemoteCreateJob, downloadRoot?: string): Promise<{ result: RemoteResult; artifacts: Record<string, Buffer> }> {
    const result = await this.control(`/jobs/${id}/result`, RemoteResultSchema);
    const m = result.manifest;
    if (m.jobId !== id || m.clientRunId !== request.clientRunId || m.profileId !== request.profileId || m.profileDigest !== request.profileDigest ||
      digest(canonical(m)) !== result.manifestDigest || (request.kind === 'text_generation') !== (m.artifacts[0]?.name === 'text')) throw new RemoteClientError('MANIFEST_MISMATCH', false);
    const artifacts: Record<string, Buffer> = {};
    for (const artifact of m.artifacts) {
      const url = result.downloads.find(d => d.name === artifact.name)!.url;
      let bytes: Buffer;
      try {
        const download = downloadRoot ? new DurableDownload(downloadRoot, { endpoint: this.endpoint, jobId: id, runId: request.clientRunId,
          requestDigest: digest(canonical(request)), manifestDigest: result.manifestDigest, name: artifact.name, bytes: artifact.bytes, sha256: artifact.sha256 }) : null;
        bytes = download ? download.complete() ?? await this.response(url, { headers: download.headers() }, response => download.consume(response)) : await this.request(url, {}, artifact.bytes);
      } catch (error) { if (error instanceof DownloadError) throw new RemoteClientError(error.code, error.retryable); throw error; }
      if (bytes.length !== artifact.bytes || digest(bytes) !== artifact.sha256) throw new RemoteClientError('ARTIFACT_HASH_MISMATCH', false);
      try {
        const schema = artifact.name === 'text' ? RemoteTextResultSchema : artifact.name === 'transcription' ? RemoteTranscriptionSchema : RemoteDiarizationSchema;
        schema.parse(JSON.parse(bytes.toString()));
      } catch { throw new RemoteClientError('INVALID_ARTIFACT', false); }
      artifacts[artifact.name] = bytes;
    }
    return { result, artifacts };
  }
}
