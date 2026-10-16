import { afterEach, expect, it, vi } from 'vitest';
import { SpeechClient, SPEAKER_REVISION } from './client.js';
import { NativeSpeechService, supportsNativeSpeech } from './service.js';
import { installSpeakerModels } from './models.js';
vi.mock('./models.js', () => ({ modelsReady: () => true, installSpeakerModels: vi.fn(async () => {}) }));
afterEach(() => vi.restoreAllMocks());
const supported = it.skipIf(!supportsNativeSpeech());
it('reports a missing helper without spawning it', async () => {
  const request = vi.spyOn(SpeechClient.prototype, 'request');
  const service = new NativeSpeechService('/missing/native-helper', '/unused');
  expect((await service.status('en')).supported).toBe(false);
  expect(request).not.toHaveBeenCalled();
  await expect(service.prepare('en')).rejects.toThrow('requires Apple silicon');
});
supported('checks the selected locale and explicitly prepares without credentials', async () => {
  const request = vi.spyOn(SpeechClient.prototype, 'request').mockResolvedValue({ result: { available: true, installed: true }, elapsedMs: 1 });
  const service = new NativeSpeechService('/usr/bin/true', '/fixture/models');
  expect((await service.status('en')).appleReady).toBe(true);
  expect(request).toHaveBeenCalledWith('health', { locale: 'en-US' });
  expect((await service.prepare('en')).phase).toBe('Ready');
  expect(installSpeakerModels).toHaveBeenCalled();
});
supported('rejects concurrent setup and supports cancellation followed by retry', async () => {
  vi.spyOn(SpeechClient.prototype, 'request').mockImplementation(async (_operation, _args, options) => {
    await new Promise<void>((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
    return { result: {}, elapsedMs: 0 };
  });
  const service = new NativeSpeechService('/usr/bin/true', '/fixture/models');
  const running = service.prepare('en');
  await expect(service.prepare('en')).rejects.toThrow('already running');
  service.cancelSetup();
  expect((await running).error).toContain('cancelled');
  expect(service.snapshot().busy).toBe(false);
  vi.spyOn(SpeechClient.prototype, 'request').mockResolvedValue({ result: {}, elapsedMs: 0 });
  expect((await service.prepare('en')).error).toBeNull();
});
supported('rejects malformed timestamps and incompatible embedding models', async () => {
  const request = vi.spyOn(SpeechClient.prototype, 'request').mockResolvedValue({ result: { text: 'x', segments: [{ start: 2, end: 1, text: 'x' }], provider: 'apple', locale: 'en', osVersion: 'fixture', durationS: 3 }, elapsedMs: 0 });
  const service = new NativeSpeechService('/usr/bin/true', '/fixture/models');
  await expect(service.transcribe('/fixture/audio.m4a', 'en')).rejects.toThrow('timestamps');
  request.mockResolvedValue({ result: { segments: [], centroids: {}, num_speakers: 0, provider: 'speakerkit', modelRevision: SPEAKER_REVISION, embeddingSpace: 'another-space' }, elapsedMs: 0 });
  await expect(service.diarize('/fixture/audio.m4a')).rejects.toThrow('incompatible');
});
supported('does not show an old locale as ready after a failed language check', async () => {
  const request = vi.spyOn(SpeechClient.prototype, 'request').mockResolvedValue({ result: { available: true, installed: true }, elapsedMs: 1 });
  const service = new NativeSpeechService('/usr/bin/true', '/fixture/models');
  expect((await service.status('en')).appleReady).toBe(true);
  request.mockRejectedValue(new Error('Unsupported locale'));
  const changed = await service.status('unsupported');
  expect(changed.appleReady).toBe(false); expect(changed.error).toContain('Unsupported locale');
});
