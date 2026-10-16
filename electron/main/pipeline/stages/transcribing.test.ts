import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runTranscribing } from './transcribing.js';
let root: string, folder: string, ctx: any;
const result = { provider: 'apple', text: 'Hello', segments: [{ start: 0, end: 1, text: 'Hello' }] };
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-native-transcribe-')); folder = path.join(root, 'meetings', 'slug'); fs.mkdirSync(folder, { recursive: true });
  ctx = { libraryRoot: root, nativeSpeech: { transcribe: vi.fn(async () => result) },
    settings: { get: () => 'en' }, speechSelection: { provider: 'native', language: 'fr' },
    meetings: { findById: () => ({ slug: 'slug', audioPath: '/mixed.m4a' }) },
    artifactCache: { invalidate: vi.fn() }, logger: { info: vi.fn() } };
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
it('uses the native helper with mixed audio and pinned locale, preserving word timing', async () => {
  await runTranscribing({ meetingId: 'm' }, ctx);
  expect(ctx.nativeSpeech.transcribe).toHaveBeenCalledWith('/mixed.m4a', 'fr');
  const file = path.join(folder, 'transcript.raw.json');
  expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ ...result, segments: [{ ...result.segments[0], wordTiming: true }] });
  expect(ctx.artifactCache.invalidate).toHaveBeenCalledWith(file);
});
it('never falls back when the native helper is missing', async () => {
  ctx.nativeSpeech = undefined;
  await expect(runTranscribing({ meetingId: 'm' }, ctx)).rejects.toThrow('Native speech helper');
});
it('preserves prior output on helper failure', async () => {
  const file = path.join(folder, 'transcript.raw.json'); fs.writeFileSync(file, 'previous');
  ctx.nativeSpeech.transcribe.mockRejectedValue(new Error('Native failure'));
  await expect(runTranscribing({ meetingId: 'm' }, ctx)).rejects.toThrow('Native failure');
  expect(fs.readFileSync(file, 'utf8')).toBe('previous');
});
