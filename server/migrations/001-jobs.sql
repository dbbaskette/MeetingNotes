CREATE TABLE IF NOT EXISTS jobs (
 id uuid PRIMARY KEY, owner_id text NOT NULL, kind text NOT NULL CHECK(kind IN ('audio_analysis','text_generation')),
 intent jsonb, state text NOT NULL DEFAULT 'uploading' CHECK(state IN ('uploading','queued','running','succeeded','failed','cancelled')),
 phase text NOT NULL DEFAULT 'uploading', revision integer NOT NULL DEFAULT 1, generation integer NOT NULL DEFAULT 0,
 attempts integer NOT NULL DEFAULT 0, lease_until timestamptz, worker_id text, cancel_requested boolean NOT NULL DEFAULT false,
 source_key text NOT NULL, upload_id text, upload_state text NOT NULL DEFAULT 'pending',
 manifest jsonb, manifest_digest text, artifact_keys jsonb, stages jsonb NOT NULL DEFAULT '{}', error_code text,
 next_attempt_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
 acknowledged_at timestamptz, deleted_at timestamptz, cleanup_at timestamptz, cleanup_attempts integer NOT NULL DEFAULT 0, cleaned_at timestamptz
);
CREATE INDEX IF NOT EXISTS jobs_queue ON jobs(next_attempt_at,created_at) WHERE deleted_at IS NULL;
CREATE TABLE IF NOT EXISTS idempotency (
 owner_id text NOT NULL, operation text NOT NULL, key text NOT NULL, request_hash text NOT NULL, job_id uuid NOT NULL REFERENCES jobs(id),
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(owner_id,operation,key)
);
CREATE TABLE IF NOT EXISTS rate_limits (bucket text PRIMARY KEY, window_at timestamptz NOT NULL, count integer NOT NULL);
