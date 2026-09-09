import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RemoteCreateJobSchema,
  RemoteDiarizationSchema,
  RemoteTextResultSchema,
} from '../../shared/remote-contracts.js';
import { authenticate } from '../src/api.js';
import { loadConfig } from '../src/config.js';
import { sanitizeDiarization, boundedJson } from '../src/processor.js';
import { hash, canonical } from '../src/util.js';
import { testConfig, TOKEN, intent } from './helpers.js';
test('token hash authentication rejects missing, invalid and expired tokens; overlap rotates owner identity', () => {
  const c = testConfig();
  assert.equal(authenticate(c, `Bearer ${TOKEN}`), 'test-owner');
  assert.throws(() => authenticate(c, undefined));
  assert.throws(() => authenticate(c, `Bearer ${'x'.repeat(40)}`));
  c.tokens[0].expiresAt = '2000-01-01T00:00:00.000Z';
  assert.throws(() => authenticate(c, `Bearer ${TOKEN}`));
  c.tokens.push({ ownerId: 'test-owner', sha256: hash('r'.repeat(40)) });
  assert.equal(authenticate(c, `Bearer ${'r'.repeat(40)}`), 'test-owner');
});
test('contract accepts opaque desktop IDs and rejects overlarge text objects and invalid action items', () => {
  const c = testConfig();
  assert.equal(
    RemoteCreateJobSchema.parse(intent(c, Buffer.from('abc'))).clientMeetingId,
    'local-short-id',
  );
  const text = intent(c, Buffer.from('{}'), 'text_generation');
  text.source.bytes = 2_000_001;
  assert.equal(RemoteCreateJobSchema.safeParse(text).success, false);
  assert.equal(
    RemoteTextResultSchema.safeParse({
      summary: 'abc',
      actionItems: [{ text: '', owner: null, due_date: 'tomorrow' }],
    }).success,
    false,
  );
});
test('nonfinite, wrong-dimension and zero embeddings become unknown with warning; finite vectors normalize', () => {
  const c = testConfig();
  const value = sanitizeDiarization(
    {
      segments: [[0, 0, 0], [NaN, 1, 0], [1], [3, 4, 0]].map((embedding, i) => ({
        start: i,
        end: i + 1,
        speaker: `s${i}`,
        embedding,
      })),
    },
    c,
  );
  assert.deepEqual(
    value.segments.slice(0, 3).map((s) => [s.speaker, s.embedding]),
    [
      ['unknown', []],
      ['unknown', []],
      ['unknown', []],
    ],
  );
  assert.deepEqual(value.segments[3].embedding, [0.6, 0.8, 0]);
  assert.equal(value.warnings.length, 3);
  assert.equal(
    RemoteDiarizationSchema.safeParse({
      ...value,
      segments: [{ start: 0, end: 1, speaker: 'a', embedding: [Infinity, 1, 0] }],
    }).success,
    false,
  );
});
test('synthetic never silently enabled and production forbids synthetic mode', () => {
  assert.throws(() => loadConfig({}));
  const c = testConfig();
  assert.throws(() => loadConfig({ ...c, NODE_ENV: 'production' } as unknown as NodeJS.ProcessEnv));
});
test('manifest canonical hash independent of object insertion order and provider bodies bounded', async () => {
  assert.equal(hash(canonical({ b: 2, a: 1 })), hash(canonical({ a: 1, b: 2 })));
  assert.notEqual(hash(canonical({ a: 1 })), hash(canonical({ a: 2 })));
  await assert.rejects(boundedJson(new Response('"oversized"'), 2), /PROVIDER_RESULT_TOO_LARGE/);
  await assert.rejects(boundedJson(new Response('', { status: 429 })), /PROVIDER_UNAVAILABLE/);
});
