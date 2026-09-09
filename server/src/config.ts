import { z } from 'zod';
import { canonical, hash } from './util.js';
import type { RemoteProfile } from '../../shared/remote-contracts.js';
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  DATABASE_URL: z.string().min(1),
  S3_ENDPOINT: z.string().url(),
  S3_PUBLIC_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().regex(/^[a-z0-9.-]{3,63}$/),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  SERVICE_ID: z.string().min(1),
  TOKEN_HASHES_JSON: z.string().min(1),
  PROCESSOR: z.enum(['providers', 'synthetic']).default('providers'),
  ALLOW_SYNTHETIC: z.enum(['true', 'false']).default('false'),
  MAX_SOURCE_BYTES: z.coerce.number().int().positive().max(1_073_741_824).default(1_073_741_824),
  MAX_DURATION_SECONDS: z.coerce.number().int().positive().max(28800).default(3600),
  MAX_TEXT_CHARACTERS: z.coerce.number().int().positive().max(500_000).default(24_000),
  MAX_QUEUED_JOBS: z.coerce.number().int().min(1).max(10).default(10),
  TRANSCRIPTION_URL: z.string().url().optional(),
  TRANSCRIPTION_MODEL: z.string().default('whisper-1'),
  TRANSCRIPTION_KEY: z.string().optional(),
  LLM_URL: z.string().url().optional(),
  LLM_MODEL: z.string().default('configured-llm'),
  LLM_CONTEXT_TOKENS: z.coerce.number().int().min(2048).max(1_000_000).default(32768),
  LLM_KEY: z.string().optional(),
  PYTHON: z.string().default('python3'),
  DIARIZATION_MODEL_PATH: z.string().optional(),
  EMBEDDING_MODEL_PATH: z.string().optional(),
  DIARIZATION_REVISION: z.string().optional(),
  EMBEDDING_REVISION: z.string().optional(),
  EMBEDDING_DIMENSION: z.coerce.number().int().positive().max(4096).default(512),
  INFERENCE_TIMEOUT_MS: z.coerce.number().int().min(1000).max(7_200_000).default(3_600_000),
});
const tokenSchema = z
  .array(
    z
      .object({
        ownerId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        expiresAt: z.string().datetime().optional(),
      })
      .strict(),
  )
  .min(1)
  .max(20);
export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const c = envSchema.parse(env);
  const tokens = tokenSchema.parse(JSON.parse(c.TOKEN_HASHES_JSON));
  if (c.PROCESSOR === 'synthetic' && (c.ALLOW_SYNTHETIC !== 'true' || c.NODE_ENV === 'production'))
    throw new Error('Synthetic processor requires explicit non-production opt-in');
  for (const url of [c.S3_ENDPOINT, c.S3_PUBLIC_ENDPOINT, c.TRANSCRIPTION_URL, c.LLM_URL].filter(
    Boolean,
  ) as string[])
    if (c.NODE_ENV === 'production' && new URL(url).protocol !== 'https:')
      throw new Error('Production endpoints require TLS');
  if (
    c.PROCESSOR === 'providers' &&
    (!c.TRANSCRIPTION_URL ||
      !c.LLM_URL ||
      !c.DIARIZATION_MODEL_PATH ||
      !c.EMBEDDING_MODEL_PATH ||
      !c.DIARIZATION_REVISION ||
      !c.EMBEDDING_REVISION)
  )
    throw new Error('Provider endpoints and pinned local model paths/revisions required');
  const identity = {
    repository: c.PROCESSOR === 'synthetic' ? 'meeting-notes/synthetic' : 'pyannote/embedding',
    revision: c.EMBEDDING_REVISION ?? 'v1',
    preprocessing: 'mono16k-pcm16-turn-v1',
    dimension: c.PROCESSOR === 'synthetic' ? 3 : c.EMBEDDING_DIMENSION,
    normalization: 'l2' as const,
  };
  const profile = {
    id: c.PROCESSOR === 'synthetic' ? 'synthetic-v1' : 'cpu-pyannote-v1',
    processor: c.PROCESSOR,
    transcriptionModel: c.TRANSCRIPTION_MODEL,
    llmModel: c.LLM_MODEL,
    embeddingIdentity: identity,
  };
  return {
    ...c,
    tokens,
    profile: {
      ...profile,
      digest: hash(
        canonical({
          ...profile,
          diarizationRevision: c.DIARIZATION_REVISION ?? 'v1',
          maxTextCharacters: c.MAX_TEXT_CHARACTERS,
          contextTokens: c.LLM_CONTEXT_TOKENS,
          maxDurationSeconds: c.MAX_DURATION_SECONDS,
          promptVersion: 1,
        }),
      ),
    } satisfies RemoteProfile,
  };
}
export type Config = ReturnType<typeof loadConfig>;
