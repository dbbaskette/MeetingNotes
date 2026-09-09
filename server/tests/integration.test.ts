import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { CreateBucketCommand, HeadObjectCommand, DeleteBucketCommand } from '@aws-sdk/client-s3';
import { buildApi } from '../src/api.js';
import { Store } from '../src/db.js';
import { Objects, PART_BYTES, cleanup } from '../src/objects.js';
import { executeJob } from '../src/worker.js';
import { Processor, runCommand } from '../src/processor.js';
import { canonical, hash, ServiceError } from '../src/util.js';
import {
  RemoteJobSchema,
  RemoteResultSchema,
  RemoteTextResultSchema,
  RemoteTranscriptionSchema,
  RemoteDiarizationSchema,
  type RemoteManifest,
} from '../../shared/remote-contracts.js';
import { testConfig, TOKEN, OTHER_TOKEN, intent } from './helpers.js';

test(
  'real PostgreSQL + S3 durability and synthetic audio/naming/text flow',
  { skip: process.env.INTEGRATION !== '1', timeout: 120_000 },
  async (t) => {
    const c = testConfig();
    const admin = new Store(c.DATABASE_URL);
    const schema = `synthetic_${randomUUID().replaceAll('-', '')}`;
    await admin.pool.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(c.DATABASE_URL);
    url.searchParams.set('options', `-c search_path=${schema}`);
    c.DATABASE_URL = url.toString();
    const store = new Store(c.DATABASE_URL);
    await store.pool.query(
      await readFile(new URL('../migrations/001-jobs.sql', import.meta.url), 'utf8'),
    );
    const objects = new Objects(c);
    await objects.client.send(new CreateBucketCommand({ Bucket: c.S3_BUCKET }));
    const app = buildApi(c, store, objects);
    const processor = new Processor(c);
    const signal = new AbortController().signal;
    const headers = (key = randomUUID(), token = TOKEN) => ({
      authorization: `Bearer ${token}`,
      'idempotency-key': key,
    });
    async function create(body: ReturnType<typeof intent>, key = randomUUID()) {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/jobs',
        headers: headers(key),
        payload: body,
      });
      assert.equal(response.statusCode, 202, response.body);
      return RemoteJobSchema.parse(response.json());
    }
    async function upload(id: string, source: Buffer, startPart = 1) {
      for (let part = startPart; part <= Math.ceil(source.length / PART_BYTES); part++) {
        const response = await app.inject({
          method: 'POST',
          url: `/v1/jobs/${id}/upload-parts`,
          headers: headers(),
          payload: { partNumbers: [part] },
        });
        assert.equal(response.statusCode, 200, response.body);
        const bytes = source.subarray((part - 1) * PART_BYTES, part * PART_BYTES);
        const result = await fetch(response.json().parts[0].url, {
          method: 'PUT',
          headers: { 'content-length': String(bytes.length) },
          body: new Uint8Array(bytes),
        });
        assert.equal(result.status, 200, await result.text());
      }
    }
    async function finish(id: string, key = randomUUID()) {
      const response = await app.inject({
        method: 'POST',
        url: `/v1/jobs/${id}/upload-completion`,
        headers: headers(key),
        payload: {},
      });
      assert.equal(response.statusCode, 202, response.body);
      return response.json();
    }
    async function drain() {
      for (let i = 0; i < 10; i++) {
        const lease = await store.claim('integration-worker');
        if (!lease) return;
        await executeJob(c, store, objects, processor, lease, signal);
      }
      throw new Error('unexpected queue loop');
    }
    let audioId = '',
      textId = '';
    try {
      await t.test(
        'all resources require auth, unknown owner cannot inspect or authorize transfers',
        async () => {
          assert.equal((await app.inject('/healthz')).statusCode, 200);
          assert.equal((await app.inject('/v1/capabilities')).statusCode, 401);
          const job = await create(intent(c, Buffer.from('synthetic')));
          audioId = job.id;
          for (const suffix of ['', '/upload', '/result'])
            assert.equal(
              (
                await app.inject({
                  url: `/v1/jobs/${job.id}${suffix}`,
                  headers: headers(undefined, OTHER_TOKEN),
                })
              ).statusCode,
              404,
            );
          for (const suffix of ['/upload-parts', '/upload-completion', '/cancellation'])
            assert.equal(
              (
                await app.inject({
                  method: 'POST',
                  url: `/v1/jobs/${job.id}${suffix}`,
                  headers: headers(undefined, OTHER_TOKEN),
                  payload: suffix === '/upload-parts' ? { partNumbers: [1] } : {},
                })
              ).statusCode,
              404,
            );
          const oversized = await app.inject({
            method: 'POST',
            url: '/v1/jobs',
            headers: headers(),
            payload: { data: 'x'.repeat(17000) },
          });
          assert.equal(oversized.statusCode, 413);
        },
      );
      await t.test(
        'same intent replay is transactional; mismatched body conflicts even under concurrent creation',
        async () => {
          const body = intent(c, Buffer.from('retry'));
          const key = randomUUID();
          const [a, b] = await Promise.all([create(body, key), create(body, key)]);
          assert.equal(a.id, b.id);
          const changed = await app.inject({
            method: 'POST',
            url: '/v1/jobs',
            headers: headers(key),
            payload: { ...body, clientRunId: randomUUID() },
          });
          assert.equal(changed.statusCode, 409);
          await store.remove('test-owner', a.id, randomUUID());
          const expired = await app.inject({
            method: 'POST',
            url: '/v1/jobs',
            headers: headers(key),
            payload: body,
          });
          assert.equal(expired.statusCode, 409);
        },
      );
      await t.test(
        'multipart interruption reconciles authoritative parts and completion recovers after S3 succeeds before DB commit',
        async () => {
          const source = Buffer.alloc(PART_BYTES + 11, 7);
          const job = await create(intent(c, source));
          audioId = job.id;
          const urls = await app.inject({
            method: 'POST',
            url: `/v1/jobs/${job.id}/upload-parts`,
            headers: headers(),
            payload: { partNumbers: [1] },
          });
          assert.equal(urls.statusCode, 200);
          assert.equal(
            (
              await fetch(urls.json().parts[0].url, {
                method: 'PUT',
                body: source.subarray(0, PART_BYTES),
              })
            ).status,
            200,
          );
          const interrupted = await app.inject({
            method: 'POST',
            url: `/v1/jobs/${job.id}/upload-completion`,
            headers: headers(),
            payload: {},
          });
          assert.equal(interrupted.statusCode, 409);
          const restarted = buildApi(c, new Store(c.DATABASE_URL), new Objects(c));
          try {
            const state = await restarted.inject({
              url: `/v1/jobs/${job.id}/upload`,
              headers: headers(),
            });
            assert.equal(state.json().parts.length, 1);
            assert.equal(state.json().parts[0].bytes, PART_BYTES);
          } finally {
            await restarted.close();
          }
          await upload(job.id, source, 2);
          const key = randomUUID();
          await finish(job.id, key);
          // Crash boundary: S3 completed, PostgreSQL transaction did not record it.
          await store.pool.query("UPDATE jobs SET upload_state='uploading' WHERE id=$1", [job.id]);
          await finish(job.id, key);
          await finish(job.id, key);
          const row = await store.get('test-owner', job.id);
          assert.equal(row.upload_state, 'verifying');
          await drain();
          assert.equal((await store.get('test-owner', job.id)).state, 'succeeded');
        },
      );
      await t.test(
        'accepted create intents replay after profile rollout or lower upload limits',
        async () => {
          const source = Buffer.from('accepted-before-configuration-change');
          const body = intent(c, source),
            stableKey = randomUUID();
          const accepted = await create(body, stableKey);
          await upload(accepted.id, source);
          await finish(accepted.id);
          await drain();
          assert.equal((await store.get('test-owner', accepted.id)).state, 'succeeded');
          const variants = [
            {
              config: { ...c, profile: { ...c.profile, digest: hash('new-model-profile') } },
              newCode: 'PROFILE_CONFLICT',
              status: 409,
            },
            {
              config: { ...c, MAX_SOURCE_BYTES: source.length - 1 },
              newCode: 'SOURCE_TOO_LARGE',
              status: 413,
            },
          ];
          for (const variant of variants) {
            const rolled = buildApi(variant.config, new Store(c.DATABASE_URL), new Objects(c));
            try {
              const replay = await rolled.inject({
                method: 'POST',
                url: '/v1/jobs',
                headers: headers(stableKey),
                payload: body,
              });
              assert.equal(replay.statusCode, 202, replay.body);
              assert.equal(replay.json().id, accepted.id);
              assert.equal(replay.json().state, 'succeeded');
              const conflict = await rolled.inject({
                method: 'POST',
                url: '/v1/jobs',
                headers: headers(stableKey),
                payload: { ...body, clientRunId: randomUUID() },
              });
              assert.equal(conflict.statusCode, 409);
              assert.equal(conflict.json().error.code, 'IDEMPOTENCY_CONFLICT');
              const fresh = await rolled.inject({
                method: 'POST',
                url: '/v1/jobs',
                headers: headers(),
                payload: body,
              });
              assert.equal(fresh.statusCode, variant.status);
              assert.equal(fresh.json().error.code, variant.newCode);
            } finally {
              await rolled.close();
            }
          }
          assert.equal(
            (
              await store.pool.query(
                "SELECT count(*)::int AS n FROM jobs WHERE intent->>'clientRunId'=$1",
                [body.clientRunId],
              )
            ).rows[0].n,
            1,
          );
        },
      );
      await t.test(
        'all operation keys survive 90 days from tombstoning rather than original creation',
        async () => {
          const body = intent(c, Buffer.from('retention-clock')),
            stableKey = randomUUID();
          const job = await create(body, stableKey);
          await store.remove('test-owner', job.id, randomUUID());
          // Day 100: created on day 0, deleted on day 30, tombstone expires on day 120.
          await store.pool.query(
            "UPDATE jobs SET created_at=now()-interval '100 days',deleted_at=now()-interval '70 days',cleaned_at=now() WHERE id=$1",
            [job.id],
          );
          await store.pool.query(
            "UPDATE idempotency SET created_at=now()-interval '100 days' WHERE job_id=$1",
            [job.id],
          );
          await store.reap();
          assert.equal(
            (
              await store.pool.query('SELECT count(*)::int AS n FROM idempotency WHERE job_id=$1', [
                job.id,
              ])
            ).rows[0].n,
            2,
          );
          const replay = await app.inject({
            method: 'POST',
            url: '/v1/jobs',
            headers: headers(stableKey),
            payload: body,
          });
          assert.equal(replay.statusCode, 409);
          assert.equal(replay.json().error.code, 'INTENT_EXPIRED');
          assert.equal(
            (await store.pool.query('SELECT count(*)::int AS n FROM jobs WHERE id=$1', [job.id]))
              .rows[0].n,
            1,
          );
          await store.pool.query(
            "UPDATE jobs SET deleted_at=now()-interval '91 days' WHERE id=$1",
            [job.id],
          );
          await store.reap();
          assert.equal(
            (
              await store.pool.query('SELECT count(*)::int AS n FROM idempotency WHERE job_id=$1', [
                job.id,
              ])
            ).rows[0].n,
            0,
          );
          assert.equal(
            (await store.pool.query('SELECT count(*)::int AS n FROM jobs WHERE id=$1', [job.id]))
              .rows[0].n,
            0,
          );
        },
      );
      await t.test(
        'immutable result sizes/hashes and schemas survive audio naming and separate text job',
        async () => {
          const response = await app.inject({
            url: `/v1/jobs/${audioId}/result`,
            headers: headers(),
          });
          assert.equal(response.statusCode, 200, response.body);
          const result = RemoteResultSchema.parse(response.json());
          assert.equal(result.manifestDigest, hash(canonical(result.manifest)));
          for (const download of result.downloads) {
            const bytes = Buffer.from(await (await fetch(download.url)).arrayBuffer());
            const artifact = result.manifest.artifacts.find((a) => a.name === download.name)!;
            assert.equal(bytes.length, artifact.bytes);
            assert.equal(hash(bytes), artifact.sha256);
            (download.name === 'transcription'
              ? RemoteTranscriptionSchema
              : RemoteDiarizationSchema
            ).parse(JSON.parse(bytes.toString()));
          }
          const row = await store.get('test-owner', audioId);
          await assert.rejects(objects.json(row.artifact_keys!.transcription, { segments: [] }));
          const input = Buffer.from(
            JSON.stringify({
              transcript: '[Speaker Alice] Synthetic meeting. I will verify the remote result.',
              summaryDetail: 'standard',
              title: 'Synthetic smoke',
              disableThinking: true,
            }),
          );
          const text = await create(intent(c, input, 'text_generation'));
          textId = text.id;
          await upload(text.id, input);
          await finish(text.id);
          await drain();
          const textResponse = await app.inject({
            url: `/v1/jobs/${text.id}/result`,
            headers: headers(),
          });
          assert.equal(textResponse.statusCode, 200, textResponse.body);
          const textResult = RemoteResultSchema.parse(textResponse.json());
          const output = await (await fetch(textResult.downloads[0].url)).json();
          assert.equal(RemoteTextResultSchema.parse(output).actionItems.length, 1);
          const ack = await app.inject({
            method: 'POST',
            url: `/v1/jobs/${audioId}/acknowledgements`,
            headers: headers(),
            payload: { manifestDigest: result.manifestDigest },
          });
          assert.equal(ack.statusCode, 200);
          assert.equal(
            (
              await app.inject({
                method: 'POST',
                url: `/v1/jobs/${audioId}/acknowledgements`,
                headers: headers(),
                payload: { manifestDigest: 'a'.repeat(64) },
              })
            ).statusCode,
            409,
          );
        },
      );
      await t.test(
        'source digest and text context checks prevent runnable unverified content',
        async () => {
          const bytes = Buffer.from('bad-digest');
          const body = intent(c, bytes);
          body.source.sha256 = '0'.repeat(64);
          const job = await create(body);
          await upload(job.id, bytes);
          await finish(job.id);
          await drain();
          assert.equal(
            (await store.get('test-owner', job.id)).error_code,
            'SOURCE_DIGEST_MISMATCH',
          );
          const text = Buffer.from(
            JSON.stringify({
              transcript: 'a'.repeat(c.MAX_TEXT_CHARACTERS + 1),
              title: null,
              summaryDetail: 'concise',
              disableThinking: false,
            }),
          );
          const oversized = await create(intent(c, text, 'text_generation'));
          await upload(oversized.id, text);
          await finish(oversized.id);
          await drain();
          assert.equal((await store.get('test-owner', oversized.id)).error_code, 'CONTEXT_LIMIT');
        },
      );
      await t.test(
        'atomic claims, expired lease takeover and cancellation fence stale publications',
        async () => {
          const job = await create(intent(c, Buffer.from('lease')));
          await store.pool.query(
            "UPDATE jobs SET state='queued',upload_state='complete' WHERE id=$1",
            [job.id],
          );
          const [first, second] = await Promise.all([
            store.claim('old-worker'),
            store.claim('other-worker'),
          ]);
          assert.equal([first, second].filter(Boolean).length, 1);
          const old = first ?? second!;
          await store.pool.query(
            "UPDATE jobs SET lease_until=now()-interval '1 second' WHERE id=$1",
            [job.id],
          );
          assert.equal(await store.heartbeat(old), false);
          const current = await store.claim('new-worker');
          assert.ok(current);
          assert.equal(current.id, job.id);
          const manifest: RemoteManifest = {
            schemaVersion: 1,
            jobId: job.id,
            clientRunId: job.clientRunId,
            profileId: c.profile.id,
            profileDigest: c.profile.digest,
            generation: current.generation,
            artifacts: [
              { name: 'text', bytes: 2, sha256: hash('{}'), contentType: 'application/json' },
            ],
          };
          assert.equal(await store.complete(old, manifest, {}), false);
          assert.equal(await store.complete(current, manifest, {}), true);
          assert.equal(await store.complete(current, manifest, {}), false);
          const cancel = await create(intent(c, Buffer.from('cancel')));
          await store.pool.query("UPDATE jobs SET state='queued' WHERE id=$1", [cancel.id]);
          const cancelledLease = await store.claim('cancel-worker');
          assert.ok(cancelledLease);
          await store.cancel('test-owner', cancel.id, randomUUID());
          assert.equal(
            await store.complete(cancelledLease, { ...manifest, jobId: cancel.id }, {}),
            false,
          );
          assert.equal((await store.get('test-owner', cancel.id)).state, 'cancelled');
        },
      );
      await t.test(
        'retention retries deletion failures, preserves acknowledged results and removes tombstoned content',
        async () => {
          await store.pool.query('UPDATE jobs SET cleanup_at=now() WHERE id=$1', [audioId]);
          const failing = new Objects({ ...c, S3_BUCKET: 'missing-synthetic-bucket' });
          try {
            await cleanup(store, failing);
          } finally {
            failing.close();
          }
          assert.ok((await store.get('test-owner', audioId)).cleanup_attempts >= 1);
          await store.pool.query('UPDATE jobs SET cleanup_at=now() WHERE id=$1', [audioId]);
          await cleanup(store, objects);
          const audio = await store.get('test-owner', audioId);
          await assert.rejects(
            objects.client.send(
              new HeadObjectCommand({ Bucket: c.S3_BUCKET, Key: audio.source_key }),
            ),
          );
          assert.ok(
            await objects.client.send(
              new HeadObjectCommand({
                Bucket: c.S3_BUCKET,
                Key: audio.artifact_keys!.transcription,
              }),
            ),
          );
          await store.remove('test-owner', textId, randomUUID());
          await cleanup(store, objects);
          assert.equal(
            (await app.inject({ url: `/v1/jobs/${textId}/result`, headers: headers() })).statusCode,
            404,
          );
          const tombstone = await store.get('test-owner', textId, true);
          assert.equal(tombstone.intent, null);
          assert.equal(tombstone.manifest, null);
          assert.deepEqual(tombstone.stages, {});
        },
      );
      await t.test(
        'stage checkpoints survive transient retries and late tombstone writes are swept again',
        async () => {
          const source = Buffer.from('stage-retry');
          const job = await create(intent(c, source));
          await upload(job.id, source);
          await finish(job.id);
          const verify = await store.claim('verify-worker');
          assert.ok(verify);
          await executeJob(c, store, objects, processor, verify, signal);
          const interrupted = new Processor(c);
          interrupted.process = async (_job, _source, _scratch, _signal, stage) => {
            await stage('transcription', RemoteTranscriptionSchema, async () => ({
              segments: [{ start: 0, end: 1, text: 'Persisted checkpoint' }],
            }));
            throw new ServiceError('PROVIDER_UNAVAILABLE', 503, true);
          };
          const attempt = await store.claim('first-attempt');
          assert.ok(attempt);
          await executeJob(c, store, objects, interrupted, attempt, signal);
          assert.equal((await store.get('test-owner', job.id)).state, 'queued');
          await store.pool.query('UPDATE jobs SET next_attempt_at=now() WHERE id=$1', [job.id]);
          const retry = await store.claim('restart-worker');
          assert.ok(retry);
          assert.equal(retry.attempts, 2);
          await executeJob(c, store, objects, processor, retry, signal);
          const completed = await store.get('test-owner', job.id);
          const transcript = RemoteTranscriptionSchema.parse(
            await objects.readJson(completed.artifact_keys!.transcription),
          );
          assert.equal(transcript.segments[0].text, 'Persisted checkpoint');
          await store.remove('test-owner', job.id, randomUUID());
          await cleanup(store, objects);
          const late = await objects.json(`jobs/${job.id}/attempts/stale/late.json`, {
            synthetic: true,
          });
          await store.pool.query('UPDATE jobs SET cleanup_at=now() WHERE id=$1', [job.id]);
          await cleanup(store, objects);
          await assert.rejects(
            objects.client.send(new HeadObjectCommand({ Bucket: c.S3_BUCKET, Key: late.key })),
          );
        },
      );
      await t.test(
        'three lost leases become a terminal safe error, not an immortal queue row',
        async () => {
          const job = await create(intent(c, Buffer.from('exhaust')));
          await store.pool.query("UPDATE jobs SET state='queued' WHERE id=$1", [job.id]);
          for (let n = 1; n <= 3; n++) {
            const lease = await store.claim(`lost-${n}`);
            assert.ok(lease);
            assert.equal(lease.attempts, n);
            await store.pool.query(
              "UPDATE jobs SET lease_until=now()-interval '1 second' WHERE id=$1",
              [job.id],
            );
          }
          await store.reap();
          assert.equal((await store.get('test-owner', job.id)).error_code, 'ATTEMPTS_EXHAUSTED');
          assert.equal(await store.claim('fourth-attempt'), null);
        },
      );
      await t.test(
        'worker shutdown aborts its subprocess and releases durable work for retry',
        async () => {
          const bytes = Buffer.from('shutdown');
          const job = await create(intent(c, bytes));
          await upload(job.id, bytes);
          await finish(job.id);
          const verify = await store.claim('shutdown-verify');
          assert.ok(verify);
          await executeJob(c, store, objects, processor, verify, signal);
          const stopper = new AbortController();
          const slow = new Processor(c);
          slow.process = async (_job, _source, _scratch, abort) => {
            setTimeout(() => stopper.abort(), 25);
            await runCommand(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], abort, 30000);
            throw new Error('Expected abort');
          };
          const lease = await store.claim('stopping-worker');
          assert.ok(lease);
          await executeJob(c, store, objects, slow, lease, stopper.signal);
          const row = await store.get('test-owner', job.id);
          assert.equal(row.state, 'queued');
          assert.equal(row.error_code, 'INTERRUPTED');
          await store.cancel('test-owner', job.id, randomUUID());
        },
      );
      await t.test('capacity and global-owner request limits bound admission', async () => {
        const telemetry = await app.inject({ url: '/v1/metrics', headers: headers() });
        assert.equal(telemetry.statusCode, 200);
        assert.ok(telemetry.json().rssBytes > 0);
        assert.ok(telemetry.json().operations['http:POST:/v1/jobs'].count > 0);
        for (let i = 0; i < 241; i++) await store.rateLimit('owner:test-owner', 240);
        const limited = await app.inject({ url: '/v1/capabilities', headers: headers() });
        assert.equal(limited.statusCode, 429);
        assert.equal(limited.headers['retry-after'], '10');
        await assert.rejects(
          store.create('limited-owner', randomUUID(), intent(c, Buffer.from('one')), {
            maxQueued: 0,
            maxSourceBytes: c.MAX_SOURCE_BYTES,
            profileId: c.profile.id,
            profileDigest: c.profile.digest,
          }),
          /CAPACITY_LIMIT/,
        );
      });
    } finally {
      // Only this suite's UUID-prefixed synthetic schema and bucket objects are targeted.
      const jobs = (await store.pool.query('SELECT * FROM jobs')).rows;
      for (const job of jobs)
        await objects.cleanupJob({ ...job, deleted_at: new Date() }).catch(() => {});
      await objects.client.send(new DeleteBucketCommand({ Bucket: c.S3_BUCKET }));
      await app.close();
      await admin.pool.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.close();
    }
  },
);
