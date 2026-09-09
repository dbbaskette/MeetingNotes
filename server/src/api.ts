import Fastify, { type FastifyRequest } from 'fastify';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import {
  RemoteCreateJobSchema,
  RemoteUploadPartsRequestSchema,
  RemoteAcknowledgementSchema,
  RemoteIdSchema,
  RemoteCapabilitiesSchema,
  RemoteResultSchema,
} from '../../shared/remote-contracts.js';
import { loadConfig, type Config } from './config.js';
import { Store, publicJob } from './db.js';
import { Objects, PART_BYTES } from './objects.js';
import { hash, ServiceError, log, observe, metrics } from './util.js';
const keySchema = z.string().regex(/^[a-zA-Z0-9_-]{8,200}$/);
export function authenticate(c: Config, authorization: unknown): string {
  if (typeof authorization !== 'string' || !/^Bearer [!-~]{32,512}$/.test(authorization))
    throw new ServiceError('UNAUTHORIZED', 401);
  const digest = Buffer.from(hash(authorization.slice(7)), 'hex');
  const token = c.tokens.find(
    (t) =>
      timingSafeEqual(digest, Buffer.from(t.sha256, 'hex')) &&
      (!t.expiresAt || Date.parse(t.expiresAt) > Date.now()),
  );
  if (!token) throw new ServiceError('UNAUTHORIZED', 401);
  return token.ownerId;
}
export function buildApi(
  config: Config,
  store = new Store(config.DATABASE_URL),
  objects = new Objects(config),
) {
  const app = Fastify({
    logger: false,
    bodyLimit: 16_384,
    requestTimeout: 60_000,
    connectionTimeout: 10_000,
    genReqId: () => randomUUID(),
  });
  const owners = new WeakMap<FastifyRequest, string>();
  const owner = (r: FastifyRequest) => owners.get(r)!;
  const id = (r: FastifyRequest) => RemoteIdSchema.parse((r.params as { id: string }).id);
  const key = (r: FastifyRequest) => keySchema.parse(r.headers['idempotency-key']);
  app.addHook('onRequest', async (r, reply) => {
    reply
      .header('cache-control', 'no-store')
      .header('x-content-type-options', 'nosniff')
      .header('x-frame-options', 'DENY')
      .header('content-security-policy', "default-src 'none'")
      .header('x-request-id', r.id);
    if (config.NODE_ENV === 'production')
      reply.header('strict-transport-security', 'max-age=31536000');
    if (r.url === '/healthz') return;
    if (!(await store.rateLimit(`ip:${hash(r.ip)}`, 300)))
      throw new ServiceError('RATE_LIMIT', 429, true);
    const who = authenticate(config, r.headers.authorization);
    owners.set(r, who);
    if (!(await store.rateLimit(`owner:${who}`, 240)))
      throw new ServiceError('RATE_LIMIT', 429, true);
  });
  app.addHook('onResponse', async (r, reply) => {
    observe(
      `http:${r.method}:${r.routeOptions.url ?? 'unmatched'}`,
      reply.elapsedTime,
      reply.statusCode >= 400,
    );
    log('http_complete', {
      requestId: r.id,
      phase: r.routeOptions.url ?? 'unmatched',
      code: `HTTP_${reply.statusCode}`,
      durationMs: reply.elapsedTime,
    });
  });
  app.setErrorHandler((e, _r, reply) => {
    const err =
      e instanceof ServiceError
        ? e
        : e instanceof z.ZodError
          ? new ServiceError('INVALID_REQUEST', 422)
          : (e as { statusCode?: number }).statusCode === 413
            ? new ServiceError('BODY_TOO_LARGE', 413)
            : [400, 415].includes((e as { statusCode?: number }).statusCode ?? 0)
              ? new ServiceError('INVALID_REQUEST', 422)
              : new ServiceError('SERVICE_UNAVAILABLE', 503, true);
    if (err.retryable) reply.header('retry-after', '10');
    reply.status(err.status).send({
      error: {
        code: err.code,
        message: err.code.replaceAll('_', ' ').toLowerCase(),
        retryable: err.retryable,
        requestId: _r.id,
      },
    });
  });
  app.setNotFoundHandler(async () => {
    throw new ServiceError('NOT_FOUND', 404);
  });
  app.get('/healthz', async () => ({ ok: true }));
  app.get('/v1/metrics', async (r) => ({
    ...metrics(),
    rssBytes: process.memoryUsage().rss,
    jobs: (
      await store.pool.query(
        `SELECT
    count(*) FILTER (WHERE state='queued')::int AS queued,
    COALESCE(max(EXTRACT(epoch FROM now()-created_at)) FILTER (WHERE state='queued'),0)::float AS oldest_queue_seconds,
    count(*) FILTER (WHERE state='running' AND lease_until<now())::int AS expired_leases,
    COALESCE(sum(GREATEST(attempts-1,0)),0)::int AS retries,
    count(*) FILTER (WHERE cleanup_at<now())::int AS cleanup_backlog
    FROM jobs WHERE owner_id=$1`,
        [owner(r)],
      )
    ).rows[0],
  }));
  app.get('/v1/capabilities', async (r) =>
    RemoteCapabilitiesSchema.parse({
      schemaVersions: [1],
      serviceId: config.SERVICE_ID,
      ownerId: owner(r),
      profiles: [config.profile],
      limits: {
        sourceBytes: config.MAX_SOURCE_BYTES,
        durationSeconds: config.MAX_DURATION_SECONDS,
        partBytes: PART_BYTES,
        concurrentParts: 2,
        queuedJobs: config.MAX_QUEUED_JOBS,
        textBytes: 2_000_000,
        textCharacters: config.MAX_TEXT_CHARACTERS,
      },
      retention: {
        abandonedUploadHours: 24,
        acknowledgedHours: 24,
        resultDays: 30,
        tombstoneDays: 90,
      },
    }),
  );
  app.post('/v1/jobs', async (r, reply) => {
    const input = RemoteCreateJobSchema.parse(r.body);
    const j = await store.create(owner(r), key(r), input, {
      maxQueued: config.MAX_QUEUED_JOBS,
      maxSourceBytes: config.MAX_SOURCE_BYTES,
      profileId: config.profile.id,
      profileDigest: config.profile.digest,
    });
    reply.status(202).header('location', `/v1/jobs/${j.id}`);
    return publicJob(j);
  });
  app.get('/v1/jobs/:id', async (r) => publicJob(await store.get(owner(r), id(r))));
  app.get('/v1/jobs/:id/upload', async (r) => {
    const j = await objects.ensureUpload(store, owner(r), id(r));
    return {
      uploadId: j.upload_id,
      partSize: PART_BYTES,
      state: j.upload_state,
      parts: await objects.parts(j),
    };
  });
  app.post('/v1/jobs/:id/upload-parts', async (r) => {
    const body = RemoteUploadPartsRequestSchema.parse(r.body);
    await store.mutate(owner(r), id(r), 'upload-parts', key(r), body, async () => {});
    return objects.uploadUrls(await objects.ensureUpload(store, owner(r), id(r)), body.partNumbers);
  });
  app.post('/v1/jobs/:id/upload-completion', async (r, reply) => {
    z.object({})
      .strict()
      .parse(r.body ?? {});
    reply.status(202);
    return publicJob(await objects.finalize(store, owner(r), id(r), key(r)));
  });
  app.get('/v1/jobs/:id/result', async (r) => {
    const j = await store.get(owner(r), id(r));
    if (j.state !== 'succeeded' || !j.manifest || !j.artifact_keys)
      throw new ServiceError('RESULT_NOT_READY', 409, true);
    return RemoteResultSchema.parse({
      manifest: j.manifest,
      manifestDigest: j.manifest_digest,
      downloads: await Promise.all(
        j.manifest.artifacts.map(async (a) => ({
          name: a.name,
          ...(await objects.downloadUrl(j.artifact_keys![a.name])),
        })),
      ),
    });
  });
  app.post('/v1/jobs/:id/acknowledgements', async (r) =>
    publicJob(
      await store.acknowledge(
        owner(r),
        id(r),
        key(r),
        RemoteAcknowledgementSchema.parse(r.body).manifestDigest,
      ),
    ),
  );
  app.post('/v1/jobs/:id/cancellation', async (r) => {
    z.object({})
      .strict()
      .parse(r.body ?? {});
    return publicJob(await store.cancel(owner(r), id(r), key(r)));
  });
  app.delete('/v1/jobs/:id', async (r, reply) => {
    await store.remove(owner(r), id(r), key(r));
    reply.status(204).send();
  });
  app.addHook('onClose', async () => {
    objects.close();
    await store.close();
  });
  return app;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const c = loadConfig();
    const app = buildApi(c);
    for (const signal of ['SIGTERM', 'SIGINT'])
      process.once(signal, () => {
        void app.close();
      });
    await app.listen({ port: c.PORT, host: '0.0.0.0' });
    log('api_ready');
  } catch {
    log('startup_failed', { code: 'CONFIG_OR_CONNECTIVITY' });
    process.exitCode = 1;
  }
}
