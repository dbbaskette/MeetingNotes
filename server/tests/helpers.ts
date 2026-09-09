import { randomUUID } from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { hash } from '../src/util.js';
import type { RemoteCreateJob } from '../../shared/remote-contracts.js';
export const TOKEN = 'synthetic-test-token-000000000000000000000000';
export const OTHER_TOKEN = 'synthetic-other-token-00000000000000000000000';
export function testConfig() {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL:
      process.env.TEST_DATABASE_URL ??
      'postgres://synthetic:synthetic-local-only@127.0.0.1:55432/meetingnotes_synthetic',
    S3_ENDPOINT: process.env.TEST_S3_ENDPOINT ?? 'http://127.0.0.1:59000',
    S3_BUCKET: `synthetic-${randomUUID()}`,
    S3_ACCESS_KEY: 'synthetic',
    S3_SECRET_KEY: 'synthetic-local-only',
    SERVICE_ID: 'synthetic-local',
    TOKEN_HASHES_JSON: JSON.stringify([
      { ownerId: 'test-owner', sha256: hash(TOKEN) },
      { ownerId: 'other-owner', sha256: hash(OTHER_TOKEN) },
    ]),
    PROCESSOR: 'synthetic',
    ALLOW_SYNTHETIC: 'true',
  });
}
export function intent(
  c: ReturnType<typeof testConfig>,
  source: Buffer,
  kind: RemoteCreateJob['kind'] = 'audio_analysis',
): RemoteCreateJob {
  return {
    schemaVersion: 1,
    kind,
    clientMeetingId: 'local-short-id',
    clientRunId: randomUUID(),
    profileId: c.profile.id,
    profileDigest: c.profile.digest,
    source: {
      bytes: source.length,
      sha256: hash(source),
      contentType: kind === 'text_generation' ? 'application/json' : 'audio/wav',
    },
  };
}
