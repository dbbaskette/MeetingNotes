import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runDiarizing } from './diarizing.js';
let root: string, folder: string, ctx: any;
const result = { segments: [{ start: 0, end: 1, speaker: 'SPEAKER_00' }], centroids: { SPEAKER_00: [1, 0] }, embeddingSpace: 'native:1', num_speakers: 1 };
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-native-diarize-')); folder = path.join(root, 'meetings', 'slug'); fs.mkdirSync(folder, { recursive: true });
  for (const name of ['audio.m4a', 'audio.system.m4a', 'audio.voice.m4a']) fs.writeFileSync(path.join(folder, name), 'fixture');
  ctx = { libraryRoot: root, nativeSpeech: { diarize: vi.fn(async () => result) },
    meetings: { findById: () => ({ slug: 'slug', audioPath: path.join(folder, 'audio.m4a') }) },
    speakers: { unlinkMeeting: vi.fn() }, artifactCache: { invalidate: vi.fn() }, logger: { info: vi.fn() } };
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
it('uses mixed audio despite stems, saves compact artifacts, clears old numeric labels', async () => {
  ctx.signal = new AbortController().signal;
  await runDiarizing({ meetingId: 'm' }, ctx);
  expect(ctx.nativeSpeech.diarize).toHaveBeenCalledWith(path.join(folder, 'audio.m4a'), { signal: ctx.signal });
  const file = path.join(folder, 'diarization.json');
  expect(fs.readFileSync(file, 'utf8')).toBe(JSON.stringify(result));
  expect(JSON.parse(fs.readFileSync(path.join(folder, 'diarization.meta.json'), 'utf8'))).toEqual({ num_speakers: 1 });
  expect(ctx.speakers.unlinkMeeting).toHaveBeenCalledWith('m');
  expect(ctx.artifactCache.invalidate).toHaveBeenCalledWith(file);
});
it('never falls back when the native helper is missing', async () => {
  ctx.nativeSpeech = undefined;
  await expect(runDiarizing({ meetingId: 'm' }, ctx)).rejects.toThrow('Native speech helper');
});
it('preserves prior artifacts and links on helper failure', async () => {
  const file = path.join(folder, 'diarization.json'); fs.writeFileSync(file, 'previous');
  ctx.nativeSpeech.diarize.mockRejectedValue(new Error('Native failure'));
  await expect(runDiarizing({ meetingId: 'm' }, ctx)).rejects.toThrow('Native failure');
  expect(fs.readFileSync(file, 'utf8')).toBe('previous');
  expect(ctx.speakers.unlinkMeeting).not.toHaveBeenCalled();
});
