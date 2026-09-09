import pg from 'pg';
import { randomUUID } from 'node:crypto';
import type { RemoteCreateJob, RemoteJob, RemoteManifest } from '../../shared/remote-contracts.js';
import { canonical, hash, ServiceError } from './util.js';
export interface JobRow {
  id: string;
  owner_id: string;
  kind: RemoteCreateJob['kind'];
  intent: RemoteCreateJob;
  state: RemoteJob['state'];
  phase: string;
  revision: number;
  generation: number;
  attempts: number;
  lease_until: Date | null;
  worker_id: string | null;
  cancel_requested: boolean;
  source_key: string;
  upload_id: string | null;
  upload_state: string;
  manifest: RemoteManifest | null;
  manifest_digest: string | null;
  artifact_keys: Record<string, string> | null;
  stages: Record<string, { key: string; sha256: string; bytes: number }>;
  error_code: string | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  cleanup_attempts: number;
}
export type Lease = Pick<JobRow, 'id' | 'generation' | 'worker_id'>;
export class Store {
  pool: pg.Pool;
  constructor(url: string) {
    this.pool = new pg.Pool({
      connectionString: url,
      max: 10,
      connectionTimeoutMillis: 5000,
      statement_timeout: 30000,
    });
  }
  async transaction<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const result = await fn(c);
      await c.query('COMMIT');
      return result;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }
  async get(owner: string, id: string, includeDeleted = false): Promise<JobRow> {
    const { rows } = await this.pool.query('SELECT * FROM jobs WHERE id=$1 AND owner_id=$2', [
      id,
      owner,
    ]);
    const job = rows[0];
    if (!job || (job.deleted_at && !includeDeleted)) throw new ServiceError('NOT_FOUND', 404);
    return job;
  }
  async create(
    owner: string,
    key: string,
    input: RemoteCreateJob,
    maxQueued: number,
  ): Promise<JobRow> {
    return this.transaction(async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [owner]);
      const digest = hash(canonical(input));
      const old = await c.query(
        'SELECT * FROM idempotency WHERE owner_id=$1 AND operation=$2 AND key=$3',
        [owner, 'create', key],
      );
      if (old.rows[0]) {
        if (old.rows[0].request_hash !== digest)
          throw new ServiceError('IDEMPOTENCY_CONFLICT', 409);
        const job = (await c.query('SELECT * FROM jobs WHERE id=$1', [old.rows[0].job_id])).rows[0];
        if (job.deleted_at) throw new ServiceError('INTENT_EXPIRED', 409);
        return job;
      }
      const count = await c.query(
        "SELECT count(*)::int AS n FROM jobs WHERE owner_id=$1 AND deleted_at IS NULL AND state IN ('uploading','queued','running')",
        [owner],
      );
      if (count.rows[0].n >= maxQueued) throw new ServiceError('CAPACITY_LIMIT', 429, true);
      const id = randomUUID();
      const job = (
        await c.query(
          'INSERT INTO jobs(id,owner_id,kind,intent,source_key) VALUES($1,$2,$3,$4,$5) RETURNING *',
          [id, owner, input.kind, input, `jobs/${id}/source`],
        )
      ).rows[0];
      await c.query(
        'INSERT INTO idempotency(owner_id,operation,key,request_hash,job_id) VALUES($1,$2,$3,$4,$5)',
        [owner, 'create', key, digest, id],
      );
      return job;
    });
  }
  async mutate(
    owner: string,
    id: string,
    operation: string,
    key: string,
    payload: unknown,
    fn: (c: pg.PoolClient, j: JobRow) => Promise<void>,
    includeDeleted = false,
  ): Promise<JobRow> {
    return this.transaction(async (c) => {
      const job = (
        await c.query('SELECT * FROM jobs WHERE id=$1 AND owner_id=$2 FOR UPDATE', [id, owner])
      ).rows[0] as JobRow | undefined;
      if (!job || (job.deleted_at && !includeDeleted)) throw new ServiceError('NOT_FOUND', 404);
      const op = `${operation}:${id}`,
        digest = hash(canonical(payload));
      await c.query(
        'INSERT INTO idempotency(owner_id,operation,key,request_hash,job_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
        [owner, op, key, digest, id],
      );
      const old = (
        await c.query(
          'SELECT request_hash FROM idempotency WHERE owner_id=$1 AND operation=$2 AND key=$3',
          [owner, op, key],
        )
      ).rows[0];
      if (old.request_hash !== digest) throw new ServiceError('IDEMPOTENCY_CONFLICT', 409);
      await fn(c, job);
      return (await c.query('SELECT * FROM jobs WHERE id=$1', [id])).rows[0];
    });
  }
  async claim(workerId: string): Promise<JobRow | null> {
    const { rows } = await this.pool.query(
      `WITH candidate AS (
      SELECT id FROM jobs WHERE deleted_at IS NULL AND cancel_requested=false AND next_attempt_at<=now()
      AND ((state='queued') OR (state='running' AND lease_until<now()) OR (state='uploading' AND upload_state='verifying' AND (lease_until IS NULL OR lease_until<now())))
      AND attempts<3 ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
      UPDATE jobs j SET state=CASE WHEN j.state='uploading' THEN 'uploading' ELSE 'running' END,
      phase=CASE WHEN j.state='uploading' THEN 'verifying_upload' ELSE 'starting' END,
      generation=generation+1,attempts=attempts+1,worker_id=$1,lease_until=now()+interval '120 seconds',revision=revision+1,updated_at=now()
      FROM candidate WHERE j.id=candidate.id RETURNING j.*`,
      [workerId],
    );
    return rows[0] ?? null;
  }
  async heartbeat(lease: Lease): Promise<boolean> {
    return (
      (
        await this.pool.query(
          `UPDATE jobs SET lease_until=now()+interval '120 seconds' WHERE id=$1 AND generation=$2 AND worker_id=$3 AND lease_until>now() AND deleted_at IS NULL AND cancel_requested=false AND state IN ('running','uploading')`,
          [lease.id, lease.generation, lease.worker_id],
        )
      ).rowCount === 1
    );
  }
  async fenced(lease: Lease, sql: string, values: unknown[] = []): Promise<boolean> {
    return (
      (
        await this.pool.query(
          `UPDATE jobs SET ${sql},revision=revision+1,updated_at=now() WHERE id=$1 AND generation=$2 AND worker_id=$3 AND lease_until>now() AND deleted_at IS NULL AND cancel_requested=false AND state IN ('running','uploading')`,
          [lease.id, lease.generation, lease.worker_id, ...values],
        )
      ).rowCount === 1
    );
  }
  async phase(lease: Lease, phase: string) {
    if (!(await this.fenced(lease, 'phase=$4', [phase]))) throw new ServiceError('LEASE_LOST', 409);
  }
  async checkpoint(lease: Lease, name: string, stage: JobRow['stages'][string]) {
    if (
      !(await this.fenced(lease, 'stages=jsonb_set(stages,ARRAY[$4::text],$5::jsonb)', [
        name,
        JSON.stringify(stage),
      ]))
    )
      throw new ServiceError('LEASE_LOST', 409);
  }
  async verified(lease: Lease) {
    return this.fenced(
      lease,
      "state='queued',phase='queued',upload_state='complete',lease_until=NULL,worker_id=NULL,attempts=0",
    );
  }
  async complete(lease: Lease, manifest: RemoteManifest, keys: Record<string, string>) {
    return this.fenced(
      lease,
      "state='succeeded',phase='complete',error_code=NULL,manifest=$4,manifest_digest=$5,artifact_keys=$6,completed_at=now(),lease_until=NULL,worker_id=NULL",
      [manifest, hash(canonical(manifest)), keys],
    );
  }
  async failed(lease: Lease, code: string, retryable: boolean) {
    return this.fenced(
      lease,
      `state=CASE WHEN $5 AND attempts<3 THEN CASE WHEN upload_state='verifying' THEN 'uploading' ELSE 'queued' END ELSE 'failed' END,phase=CASE WHEN $5 AND attempts<3 THEN 'retry_wait' ELSE 'failed' END,error_code=$4,next_attempt_at=now()+make_interval(secs=>power(2,attempts)::int*5),completed_at=CASE WHEN $5 AND attempts<3 THEN NULL ELSE now() END,lease_until=NULL,worker_id=NULL`,
      [code, retryable],
    );
  }
  async cancel(owner: string, id: string, key: string) {
    return this.mutate(owner, id, 'cancel', key, {}, async (c, j) => {
      if (['succeeded', 'failed', 'cancelled'].includes(j.state)) return;
      await c.query(
        "UPDATE jobs SET cancel_requested=true,state='cancelled',phase='cancelled',generation=generation+1,revision=revision+1,updated_at=now(),completed_at=now(),cleanup_at=now(),lease_until=NULL WHERE id=$1",
        [id],
      );
    });
  }
  async acknowledge(owner: string, id: string, key: string, digest: string) {
    return this.mutate(owner, id, 'ack', key, { manifestDigest: digest }, async (c, j) => {
      if (j.state !== 'succeeded' || j.manifest_digest !== digest)
        throw new ServiceError('MANIFEST_CONFLICT', 409);
      await c.query(
        "UPDATE jobs SET acknowledged_at=COALESCE(acknowledged_at,now()),cleanup_at=COALESCE(cleanup_at,now()+interval '24 hours') WHERE id=$1",
        [id],
      );
    });
  }
  async remove(owner: string, id: string, key: string) {
    return this.mutate(
      owner,
      id,
      'delete',
      key,
      {},
      async (c, j) => {
        if (j.deleted_at) return;
        await c.query(
          "UPDATE jobs SET deleted_at=now(),intent=NULL,manifest=NULL,manifest_digest=NULL,artifact_keys=NULL,stages='{}',cancel_requested=true,generation=generation+1,revision=revision+1,cleanup_at=now(),updated_at=now() WHERE id=$1",
          [id],
        );
      },
      true,
    );
  }
  async rateLimit(bucket: string, limit: number): Promise<boolean> {
    const { rows } = await this.pool.query(
      `INSERT INTO rate_limits(bucket,window_at,count) VALUES($1,date_trunc('minute',now()),1) ON CONFLICT(bucket) DO UPDATE SET count=CASE WHEN rate_limits.window_at<date_trunc('minute',now()) THEN 1 ELSE rate_limits.count+1 END,window_at=date_trunc('minute',now()) RETURNING count`,
      [bucket],
    );
    return rows[0].count <= limit;
  }
  async reap() {
    await this.pool.query(
      "UPDATE jobs SET state='failed',phase='failed',error_code='ATTEMPTS_EXHAUSTED',completed_at=now(),revision=revision+1 WHERE attempts>=3 AND lease_until<now() AND state IN ('running','uploading') AND deleted_at IS NULL",
    );
    await this.pool.query(
      "UPDATE jobs SET deleted_at=now(),intent=NULL,manifest=NULL,manifest_digest=NULL,artifact_keys=NULL,stages='{}',generation=generation+1,revision=revision+1,cleanup_at=now() WHERE deleted_at IS NULL AND ((state='uploading' AND created_at<now()-interval '24 hours') OR completed_at<now()-interval '30 days')",
    );
    await this.pool.query("DELETE FROM rate_limits WHERE window_at<now()-interval '1 day'");
    await this.pool.query(
      "DELETE FROM idempotency WHERE created_at<now()-interval '90 days' AND job_id IN (SELECT id FROM jobs WHERE cleaned_at IS NOT NULL AND deleted_at IS NOT NULL)",
    );
    await this.pool.query(
      "DELETE FROM jobs WHERE deleted_at<now()-interval '90 days' AND cleaned_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM idempotency WHERE job_id=jobs.id)",
    );
  }
  async close() {
    await this.pool.end();
  }
}
export function publicJob(j: JobRow): RemoteJob {
  return {
    id: j.id,
    kind: j.kind,
    clientRunId: j.intent.clientRunId,
    state: j.state,
    phase: j.phase,
    revision: j.revision,
    cancelRequested: j.cancel_requested,
    createdAt: j.created_at.toISOString(),
    updatedAt: j.updated_at.toISOString(),
    resultAvailable: !!j.manifest && !j.deleted_at,
    error: j.error_code
      ? { code: j.error_code, retryable: j.state === 'queued' || j.phase === 'retry_wait' }
      : null,
  };
}
