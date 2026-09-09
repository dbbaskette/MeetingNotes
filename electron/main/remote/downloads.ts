import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export class DownloadError extends Error {
  constructor(readonly code: string, readonly retryable = false) { super(code); }
}
export interface DownloadIdentity {
  endpoint: string; jobId: string; runId: string; requestDigest: string; manifestDigest: string;
  name: 'transcription' | 'diarization' | 'text'; bytes: number; sha256: string;
}
interface Checkpoint { identity: DownloadIdentity; offset: number; prefixSha256: string }
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** Fixed local paths, pinned immutable identity, fsynced bytes-before-checkpoint.
 * A crash between append and checkpoint leaves an uncommitted tail, truncated on
 * reopen. Signed URLs never enter the checkpoint and may be renewed freely.
 */
export class DurableDownload {
  readonly partialPath: string;
  private checkpointPath: string;
  private offset = 0;
  private hasher = createHash('sha256');
  constructor(root: string, private identity: DownloadIdentity) {
    if (!/^[a-f0-9]{64}$/.test(identity.manifestDigest) || !['transcription', 'diarization', 'text'].includes(identity.name) ||
      !Number.isSafeInteger(identity.bytes) || identity.bytes <= 0 || identity.bytes > 20_000_000) throw new DownloadError('INVALID_DOWNLOAD_IDENTITY');
    const dir = path.join(root, identity.manifestDigest);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.partialPath = path.join(dir, `${identity.name}.part`);
    this.checkpointPath = path.join(dir, `${identity.name}.checkpoint.json`);
    if (fs.existsSync(this.checkpointPath)) {
      let saved: Checkpoint;
      try {
        if (fs.statSync(this.checkpointPath).size > 16_384) throw new Error();
        saved = JSON.parse(fs.readFileSync(this.checkpointPath, 'utf8')) as Checkpoint;
        if (JSON.stringify(saved.identity) !== JSON.stringify(identity) || !Number.isSafeInteger(saved.offset) || saved.offset < 0 || saved.offset > identity.bytes) throw new Error();
        const stat = fs.statSync(this.partialPath);
        if (!stat.isFile() || stat.size < saved.offset || stat.size > identity.bytes) throw new Error();
        const bytes = fs.readFileSync(this.partialPath).subarray(0, saved.offset);
        if (hash(bytes) !== saved.prefixSha256) throw new Error();
        this.offset = saved.offset; this.hasher.update(bytes);
        fs.truncateSync(this.partialPath, this.offset);
      } catch { throw new DownloadError('INVALID_DOWNLOAD_CHECKPOINT'); }
    } else {
      // A pre-checkpoint file is never trusted, even if it happens to have the right size.
      const fd = fs.openSync(this.partialPath, 'w', 0o600);
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      this.checkpoint();
    }
  }
  private checkpoint(): void {
    const value: Checkpoint = { identity: this.identity, offset: this.offset, prefixSha256: this.hasher.copy().digest('hex') };
    const temp = `${this.checkpointPath}.${randomUUID()}.tmp`;
    const fd = fs.openSync(temp, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, this.checkpointPath);
    const dir = fs.openSync(path.dirname(this.checkpointPath), 'r');
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  }
  headers(): Record<string, string> {
    return { 'Accept-Encoding': 'identity', ...(this.offset ? { Range: `bytes=${this.offset}-` } : {}) };
  }
  complete(): Buffer | null {
    if (this.offset !== this.identity.bytes) return null;
    const bytes = fs.readFileSync(this.partialPath);
    if (bytes.length !== this.identity.bytes || hash(bytes) !== this.identity.sha256) throw new DownloadError('ARTIFACT_HASH_MISMATCH');
    return bytes;
  }
  async consume(response: Response): Promise<Buffer> {
    const encoding = response.headers.get('content-encoding');
    if (encoding && encoding !== 'identity') throw new DownloadError('INVALID_DOWNLOAD_ENCODING');
    let start = this.offset;
    if (response.status === 206) {
      const expected = `bytes ${start}-${this.identity.bytes - 1}/${this.identity.bytes}`;
      if (response.headers.get('content-range') !== expected) throw new DownloadError('INVALID_CONTENT_RANGE');
    } else if (response.status === 200) {
      if (response.headers.has('content-range')) throw new DownloadError('INVALID_CONTENT_RANGE');
      start = 0; // Range ignored: replace, NEVER append a full representation.
    } else throw new DownloadError('INVALID_DOWNLOAD_STATUS');
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) !== this.identity.bytes - start)) throw new DownloadError('INVALID_DOWNLOAD_LENGTH');
    const reader = response.body?.getReader();
    if (!reader) throw new DownloadError('INCOMPLETE_DOWNLOAD', true);
    const fd = fs.openSync(this.partialPath, 'r+');
    try {
      if (start !== this.offset) {
        fs.ftruncateSync(fd, 0); fs.fsyncSync(fd); this.offset = 0; this.hasher = createHash('sha256'); this.checkpoint();
      }
      for (;;) {
        const part = await reader.read(); if (part.done) break;
        if (this.offset + part.value.byteLength > this.identity.bytes) throw new DownloadError('RESPONSE_TOO_LARGE');
        let written = 0;
        while (written < part.value.byteLength) written += fs.writeSync(fd, part.value, written, part.value.byteLength - written, this.offset + written);
        fs.fsyncSync(fd);
        this.hasher.update(part.value); this.offset += part.value.byteLength; this.checkpoint();
      }
    } finally { fs.closeSync(fd); await reader.cancel().catch(() => {}); }
    const completed = this.complete();
    if (!completed) throw new DownloadError('INCOMPLETE_DOWNLOAD', true);
    return completed;
  }
}
