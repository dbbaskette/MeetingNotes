import {
  S3Client,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  ListPartsCommand,
  CompleteMultipartUploadCommand,
  HeadObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  AbortMultipartUploadCommand,
  ListMultipartUploadsCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { Transform, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Config } from './config.js';
import { Store, type JobRow } from './db.js';
import { hash, ServiceError, log, observe } from './util.js';
export const PART_BYTES = 16_777_216;
const missing = (e: unknown) =>
  ['NoSuchUpload', 'NotFound', 'NoSuchKey'].includes((e as { name?: string }).name ?? '');
export class Objects {
  client: S3Client;
  signer: S3Client;
  constructor(readonly config: Config) {
    const options = {
      region: config.S3_REGION,
      forcePathStyle: true,
      credentials: { accessKeyId: config.S3_ACCESS_KEY, secretAccessKey: config.S3_SECRET_KEY },
      maxAttempts: 3,
      requestHandler: {
        connectionTimeout: 5000,
        socketTimeout: 30000,
        requestTimeout: 120000,
        throwOnRequestTimeout: true,
      },
    };
    this.client = new S3Client({ ...options, endpoint: config.S3_ENDPOINT });
    this.client.middlewareStack.add(
      (next, context) => async (args) => {
        const start = Date.now();
        let failed = false;
        try {
          return await next(args);
        } catch (e) {
          failed = true;
          throw e;
        } finally {
          observe(`s3:${context.commandName}`, Date.now() - start, failed);
        }
      },
      { step: 'initialize', name: 'safeMetrics' },
    );
    this.signer = new S3Client({
      ...options,
      endpoint: config.S3_PUBLIC_ENDPOINT ?? config.S3_ENDPOINT,
    });
  }
  async ensureUpload(store: Store, owner: string, id: string): Promise<JobRow> {
    return store.transaction(async (c) => {
      const j = (
        await c.query('SELECT * FROM jobs WHERE id=$1 AND owner_id=$2 FOR UPDATE', [id, owner])
      ).rows[0] as JobRow | undefined;
      if (!j || j.deleted_at) throw new ServiceError('NOT_FOUND', 404);
      if (j.upload_state !== 'pending' || j.state !== 'uploading') return j;
      const out = await this.client.send(
        new CreateMultipartUploadCommand({
          Bucket: this.config.S3_BUCKET,
          Key: j.source_key,
          ContentType: j.intent.source.contentType,
        }),
      );
      return (
        await c.query(
          "UPDATE jobs SET upload_id=$2,upload_state='uploading',updated_at=now() WHERE id=$1 RETURNING *",
          [id, out.UploadId],
        )
      ).rows[0];
    });
  }
  async parts(j: JobRow) {
    if (!j.upload_id || j.upload_state !== 'uploading') return [];
    const result = [];
    let marker: string | undefined;
    do {
      const out = await this.client.send(
        new ListPartsCommand({
          Bucket: this.config.S3_BUCKET,
          Key: j.source_key,
          UploadId: j.upload_id,
          PartNumberMarker: marker,
        }),
      );
      for (const p of out.Parts ?? [])
        result.push({ partNumber: p.PartNumber!, etag: p.ETag!, bytes: p.Size! });
      marker = out.IsTruncated ? out.NextPartNumberMarker : undefined;
    } while (marker);
    return result;
  }
  async uploadUrls(j: JobRow, numbers: number[]) {
    if (j.state !== 'uploading' || j.upload_state !== 'uploading' || !j.upload_id)
      throw new ServiceError('UPLOAD_CLOSED', 409);
    const count = Math.ceil(j.intent.source.bytes / PART_BYTES);
    if (new Set(numbers).size !== numbers.length || numbers.some((n) => n > count))
      throw new ServiceError('INVALID_PART', 422);
    return {
      parts: await Promise.all(
        numbers.map(async (partNumber) => ({
          partNumber,
          url: await getSignedUrl(
            this.signer,
            new UploadPartCommand({
              Bucket: this.config.S3_BUCKET,
              Key: j.source_key,
              UploadId: j.upload_id!,
              PartNumber: partNumber,
              ContentLength: Math.min(
                PART_BYTES,
                j.intent.source.bytes - (partNumber - 1) * PART_BYTES,
              ),
            }),
            { expiresIn: 900, signableHeaders: new Set(['content-length']) },
          ),
          expiresAt: new Date(Date.now() + 900000).toISOString(),
        })),
      ),
    };
  }
  async finalize(store: Store, owner: string, id: string, key: string) {
    return store.mutate(owner, id, 'upload-completion', key, {}, async (c, j) => {
      if (j.upload_state === 'verifying' || j.upload_state === 'complete') return;
      if (j.state !== 'uploading' || !j.upload_id) throw new ServiceError('UPLOAD_CLOSED', 409);
      let exists = false;
      try {
        const head = await this.client.send(
          new HeadObjectCommand({ Bucket: this.config.S3_BUCKET, Key: j.source_key }),
        );
        exists = head.ContentLength === j.intent.source.bytes;
        if (!exists) throw new ServiceError('SOURCE_SIZE_MISMATCH');
      } catch (e) {
        if (!missing(e)) throw e;
      }
      if (!exists) {
        const parts = await this.parts(j);
        const count = Math.ceil(j.intent.source.bytes / PART_BYTES);
        if (
          parts.length !== count ||
          parts.some(
            (p, i) =>
              p.partNumber !== i + 1 ||
              p.bytes !== Math.min(PART_BYTES, j.intent.source.bytes - i * PART_BYTES),
          )
        )
          throw new ServiceError('UPLOAD_INCOMPLETE', 409, true);
        await this.client.send(
          new CompleteMultipartUploadCommand({
            Bucket: this.config.S3_BUCKET,
            Key: j.source_key,
            UploadId: j.upload_id,
            MultipartUpload: {
              Parts: parts.map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })),
            },
          }),
        );
      }
      await c.query(
        "UPDATE jobs SET upload_state='verifying',phase='verifying_upload',revision=revision+1,updated_at=now() WHERE id=$1",
        [j.id],
      );
    });
  }
  async download(
    key: string,
    path: string,
    expected: { bytes: number; sha256: string },
    signal?: AbortSignal,
  ) {
    const out = await this.client.send(
      new GetObjectCommand({ Bucket: this.config.S3_BUCKET, Key: key }),
      { abortSignal: signal },
    );
    if (out.ContentLength !== expected.bytes) throw new ServiceError('SOURCE_SIZE_MISMATCH');
    let bytes = 0;
    const digest = createHash('sha256');
    const check = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > expected.bytes) return callback(new ServiceError('SOURCE_SIZE_MISMATCH'));
        digest.update(chunk);
        callback(null, chunk);
      },
    });
    await pipeline(
      out.Body as Readable,
      check,
      createWriteStream(path, { flags: 'wx', mode: 0o600 }),
      { signal },
    );
    if (bytes !== expected.bytes || digest.digest('hex') !== expected.sha256)
      throw new ServiceError('SOURCE_DIGEST_MISMATCH');
  }
  async json(key: string, value: unknown) {
    const body = Buffer.from(JSON.stringify(value));
    if (body.length > 20_000_000) throw new ServiceError('RESULT_TOO_LARGE');
    const sha256 = hash(body);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.S3_BUCKET,
        Key: key,
        Body: body,
        ContentType: 'application/json',
        IfNoneMatch: '*',
      }),
    );
    return { key, sha256, bytes: body.length };
  }
  async readJson(key: string, maxBytes = 20_000_000): Promise<unknown> {
    const out = await this.client.send(
      new GetObjectCommand({ Bucket: this.config.S3_BUCKET, Key: key }),
    );
    let bytes = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of out.Body as Readable) {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        (out.Body as Readable).destroy();
        throw new ServiceError('RESULT_TOO_LARGE');
      }
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  async downloadUrl(key: string) {
    return {
      url: await getSignedUrl(
        this.signer,
        new GetObjectCommand({ Bucket: this.config.S3_BUCKET, Key: key }),
        { expiresIn: 900 },
      ),
      expiresAt: new Date(Date.now() + 900000).toISOString(),
    };
  }
  async cleanupJob(j: JobRow) {
    // Cancelled/stale attempt objects are also inside this prefix. Retain only published results after acknowledgement.
    const keep = new Set(
      !j.deleted_at && j.state === 'succeeded' ? Object.values(j.artifact_keys ?? {}) : [],
    );
    let token: string | undefined;
    do {
      const out = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.config.S3_BUCKET,
          Prefix: `jobs/${j.id}/`,
          ContinuationToken: token,
        }),
      );
      const keys = (out.Contents ?? [])
        .filter((o) => !keep.has(o.Key!))
        .map((o) => ({ Key: o.Key! }));
      if (keys.length) {
        const deleted = await this.client.send(
          new DeleteObjectsCommand({ Bucket: this.config.S3_BUCKET, Delete: { Objects: keys } }),
        );
        if (deleted.Errors?.length) throw new ServiceError('CLEANUP_FAILED', 503, true);
      }
      token = out.IsTruncated ? out.NextContinuationToken : undefined;
    } while (token);
    let keyMarker: string | undefined, uploadMarker: string | undefined;
    do {
      const out = await this.client.send(
        new ListMultipartUploadsCommand({
          Bucket: this.config.S3_BUCKET,
          Prefix: `jobs/${j.id}/`,
          KeyMarker: keyMarker,
          UploadIdMarker: uploadMarker,
        }),
      );
      for (const u of out.Uploads ?? [])
        try {
          await this.client.send(
            new AbortMultipartUploadCommand({
              Bucket: this.config.S3_BUCKET,
              Key: u.Key!,
              UploadId: u.UploadId!,
            }),
          );
        } catch (e) {
          if (!missing(e)) throw e;
        }
      keyMarker = out.IsTruncated ? out.NextKeyMarker : undefined;
      uploadMarker = out.NextUploadIdMarker;
    } while (keyMarker);
  }
  close() {
    this.client.destroy();
    this.signer.destroy();
  }
}
export async function cleanup(store: Store, objects: Objects) {
  await store.reap();
  await store.transaction(async (c) => {
    const rows = (
      await c.query(
        'SELECT * FROM jobs WHERE cleanup_at<=now() ORDER BY cleanup_at FOR UPDATE SKIP LOCKED LIMIT 5',
      )
    ).rows as JobRow[];
    for (const j of rows)
      try {
        await objects.cleanupJob(j);
        await c.query(
          // Re-sweep after the maximum inference/URL lifetime to catch late writes
          // from already-fenced attempts. Never depend on a single delete pass.
          "UPDATE jobs SET cleanup_at=now()+interval '24 hours',cleaned_at=now(),stages='{}',upload_id=NULL WHERE id=$1",
          [j.id],
        );
        log('cleanup_complete', { jobId: j.id });
      } catch {
        await c.query(
          'UPDATE jobs SET cleanup_attempts=cleanup_attempts+1,cleanup_at=now()+make_interval(secs=>LEAST(3600,power(2,LEAST(cleanup_attempts,10))::int*10)) WHERE id=$1',
          [j.id],
        );
        log('cleanup_retry', { jobId: j.id, code: 'CLEANUP_FAILED' });
      }
  });
}
