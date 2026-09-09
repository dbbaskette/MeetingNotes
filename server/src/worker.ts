import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { RemoteManifestSchema } from '../../shared/remote-contracts.js';
import { loadConfig, type Config } from './config.js';
import { Store, type JobRow } from './db.js';
import { Objects, cleanup } from './objects.js';
import { Processor, validateText, type Stage } from './processor.js';
import { log, ServiceError, observe } from './util.js';
export async function executeJob(
  c: Config,
  store: Store,
  objects: Objects,
  processor: Processor,
  job: JobRow,
  shutdown: AbortSignal,
) {
  const dir = await mkdtemp(path.join(tmpdir(), 'meeting-remote-'));
  const controller = new AbortController();
  const signal = AbortSignal.any([
    shutdown,
    controller.signal,
    AbortSignal.timeout(c.INFERENCE_TIMEOUT_MS),
  ]);
  let heartbeatRunning = false;
  const heartbeat = setInterval(() => {
    if (heartbeatRunning) return;
    heartbeatRunning = true;
    void store
      .heartbeat(job)
      .then(
        (ok) => {
          if (!ok) controller.abort();
        },
        () => controller.abort(),
      )
      .finally(() => {
        heartbeatRunning = false;
      });
  }, 15000);
  const start = Date.now();
  log('job_claimed', { jobId: job.id, phase: job.phase, attempts: job.attempts });
  try {
    if (job.intent.profileDigest !== c.profile.digest)
      throw new ServiceError('PROFILE_UNAVAILABLE');
    const source = path.join(dir, 'source');
    await objects.download(job.source_key, source, job.intent.source, signal);
    if (job.state === 'uploading') {
      if (job.kind === 'text_generation') await validateText(source, c);
      if (!(await store.verified(job))) throw new ServiceError('LEASE_LOST', 409);
      log('upload_verified', { jobId: job.id, bytes: job.intent.source.bytes });
      return;
    }
    const artifacts: Record<string, { key: string; sha256: string; bytes: number }> = {};
    const stage: Stage = async (name, schema, compute) => {
      const stageStart = Date.now();
      log('stage_started', { jobId: job.id, phase: name, rssBytes: process.memoryUsage().rss });
      signal.throwIfAborted();
      await store.phase(
        job,
        name === 'text' ? 'summarizing' : name === 'transcription' ? 'transcribing' : 'diarizing',
      );
      const cached = job.stages[name];
      if (cached) {
        const cachedFile = path.join(dir, `cached-${name}.json`);
        try {
          await objects.download(cached.key, cachedFile, cached, signal);
          const value = schema.parse(JSON.parse(await readFile(cachedFile, 'utf8')));
          artifacts[name] = cached;
          log('stage_reused', { jobId: job.id, phase: name, durationMs: Date.now() - stageStart });
          return value;
        } catch (e) {
          if (
            !(
              e instanceof z.ZodError ||
              e instanceof SyntaxError ||
              (e instanceof ServiceError &&
                ['SOURCE_SIZE_MISMATCH', 'SOURCE_DIGEST_MISMATCH'].includes(e.code)) ||
              (e as { name?: string }).name === 'NoSuchKey'
            )
          )
            throw e;
          log('stage_cache_invalid', { jobId: job.id, phase: name, code: 'RECOMPUTE' });
        }
      }
      const value = schema.parse(await compute());
      signal.throwIfAborted();
      const result = await objects.json(
        `jobs/${job.id}/attempts/${job.generation}/${name}-${randomUUID()}.json`,
        value,
      );
      await store.checkpoint(job, name, result);
      artifacts[name] = result;
      observe(`stage:${name}`, Date.now() - stageStart, false);
      log('stage_completed', {
        jobId: job.id,
        phase: name,
        durationMs: Date.now() - stageStart,
        rssBytes: process.memoryUsage().rss,
      });
      return value;
    };
    await processor.process(job, source, dir, signal, stage);
    const manifest = RemoteManifestSchema.parse({
      schemaVersion: 1,
      jobId: job.id,
      clientRunId: job.intent.clientRunId,
      profileId: job.intent.profileId,
      profileDigest: job.intent.profileDigest,
      generation: job.generation,
      artifacts: Object.entries(artifacts).map(([name, a]) => ({
        name,
        sha256: a.sha256,
        bytes: a.bytes,
        contentType: 'application/json',
      })),
    });
    if (
      !(await store.complete(
        job,
        manifest,
        Object.fromEntries(Object.entries(artifacts).map(([n, a]) => [n, a.key])),
      ))
    )
      throw new ServiceError('LEASE_LOST', 409);
    log('job_completed', { jobId: job.id, durationMs: Date.now() - start });
  } catch (e) {
    const known = e instanceof ServiceError;
    const code = signal.aborted
      ? 'INTERRUPTED'
      : known
        ? e.code
        : e instanceof z.ZodError || e instanceof SyntaxError
          ? 'INVALID_CONTENT'
          : signal.aborted
            ? 'INTERRUPTED'
            : 'DEPENDENCY_UNAVAILABLE';
    await store.failed(
      job,
      code,
      signal.aborted ||
        (known ? e.retryable : !(e instanceof z.ZodError || e instanceof SyntaxError)),
    );
    log('job_failed', { jobId: job.id, code, durationMs: Date.now() - start });
  } finally {
    clearInterval(heartbeat);
    await rm(dir, { recursive: true, force: true });
  }
}
export async function runWorker(c: Config, signal: AbortSignal) {
  const store = new Store(c.DATABASE_URL),
    objects = new Objects(c),
    processor = new Processor(c),
    workerId = randomUUID();
  let lastCleanup = 0;
  try {
    while (!signal.aborted) {
      try {
        if (Date.now() - lastCleanup > 60000) {
          await cleanup(store, objects);
          lastCleanup = Date.now();
        }
        const job = await store.claim(workerId);
        if (job) await executeJob(c, store, objects, processor, job, signal);
        else await delay(1000, undefined, { signal });
      } catch {
        if (!signal.aborted) {
          log('worker_dependency_error', { code: 'DEPENDENCY_UNAVAILABLE' });
          await delay(5000, undefined, { signal }).catch(() => {});
        }
      }
    }
  } finally {
    objects.close();
    await store.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const shutdown = new AbortController();
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => shutdown.abort());
  try {
    await runWorker(loadConfig(), shutdown.signal);
  } catch {
    log('startup_failed', { code: 'CONFIG_OR_CONNECTIVITY' });
    process.exitCode = 1;
  }
}
