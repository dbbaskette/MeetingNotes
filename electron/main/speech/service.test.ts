import { afterEach, expect, it, vi } from 'vitest';
import { SpeechClient, SPEAKER_REVISION } from './client.js';
import { NativeSpeechService, supportsNativeSpeech } from './service.js';
import { installSpeakerModels } from './models.js';
import { installWhisperModels } from './whisper-models.js';
vi.mock('./models.js', () => ({ modelsReady: () => true, installSpeakerModels: vi.fn(async () => {}) }));
const whisper = vi.hoisted(() => ({ ready: false }));
vi.mock('./whisper-models.js', () => ({ whisperModelsReady: () => whisper.ready, whisperModelFolder: () => '/fixture/whisperkit',
  WHISPER_DOWNLOAD_BYTES: 627e6, installWhisperModels: vi.fn(async () => { whisper.ready = true; }) }));
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); whisper.ready = false; });
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
supported('reuses a ready health answer for the same locale instead of respawning the helper', async () => {
  const request = vi.spyOn(SpeechClient.prototype, 'request').mockResolvedValue({ result: { available: true, installed: true }, elapsedMs: 1 });
  const service = new NativeSpeechService('/usr/bin/true', '/fixture/models');
  expect((await service.status('en')).appleReady).toBe(true);
  expect((await service.status('en')).appleReady).toBe(true);
  expect(request).toHaveBeenCalledTimes(1);
  await service.status('de');
  expect(request).toHaveBeenCalledTimes(2);
  expect(request).toHaveBeenLastCalledWith('health', { locale: 'de' });
});
supported('re-checks every time while the language assets are not installed', async () => {
  const request = vi.spyOn(SpeechClient.prototype, 'request').mockResolvedValue({ result: { available: true, installed: false }, elapsedMs: 1 });
  const service = new NativeSpeechService('/usr/bin/true', '/fixture/models');
  expect((await service.status('en')).appleReady).toBe(false);
  request.mockResolvedValue({ result: { available: true, installed: true }, elapsedMs: 1 });
  expect((await service.status('en')).appleReady).toBe(true);
  expect(request).toHaveBeenCalledTimes(2);
});

const transcript = (provider: string) => ({ text: 'hello there', segments: [{ start: 0, end: 1, text: 'hello' }, { start: 1, end: 2, text: 'there' }],
  provider, locale: 'en', osVersion: 'fixture', durationS: 3 });
supported('checks the WhisperKit model without asking Apple about a language it may not offer', async () => {
  const request = vi.spyOn(SpeechClient.prototype, 'request').mockRejectedValue(new Error('Unsupported locale'));
  const service = new NativeSpeechService('/usr/bin/true', '/fixture/models', '/fixture/whisperkit');
  const missing = await service.status('yue', 'whisperkit');
  expect(missing).toMatchObject({ engine: 'whisperkit', whisperReady: false, transcriptionReady: false, error: null });
  whisper.ready = true;
  expect(await service.status('yue', 'whisperkit')).toMatchObject({ whisperReady: true, transcriptionReady: true, speakerReady: true });
  expect(request).not.toHaveBeenCalled();
  // The same Mac asked about Apple speech reports Apple's own readiness.
  request.mockResolvedValue({ result: { available: true, installed: false }, elapsedMs: 1 });
  expect(await service.status('en', 'apple')).toMatchObject({ engine: 'apple', appleReady: false, transcriptionReady: false, whisperReady: true });
});
supported('prepares WhisperKit explicitly: speaker models, verified download, then one load to optimize it', async () => {
  const request = vi.spyOn(SpeechClient.prototype, 'request').mockResolvedValue({ result: { installed: true }, elapsedMs: 1 });
  const service = new NativeSpeechService('/usr/bin/true', '/fixture/models', '/fixture/whisperkit');
  const done = await service.prepare('en', 'whisperkit');
  expect(done).toMatchObject({ phase: 'Ready', whisperReady: true, speakerReady: true, transcriptionReady: true, busy: false, error: null });
  expect(installSpeakerModels).toHaveBeenCalled();
  expect(installWhisperModels).toHaveBeenCalledWith('/fixture/whisperkit', expect.any(AbortSignal), expect.any(Function));
  // Apple assets are not provisioned for this engine.
  expect(request.mock.calls.map(call => call[0])).toEqual(['prepare-whisperkit']);
  expect(request).toHaveBeenCalledWith('prepare-whisperkit', { modelFolder: '/fixture/whisperkit' }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
});
supported('reports a failed WhisperKit download and leaves the engine not ready', async () => {
  vi.spyOn(SpeechClient.prototype, 'request').mockResolvedValue({ result: {}, elapsedMs: 1 });
  vi.mocked(installWhisperModels).mockRejectedValueOnce(new Error('Model download failed (503). Retry while online.'));
  const service = new NativeSpeechService('/usr/bin/true', '/fixture/models', '/fixture/whisperkit');
  const failed = await service.prepare('en', 'whisperkit');
  expect(failed).toMatchObject({ whisperReady: false, transcriptionReady: false, busy: false });
  expect(failed.error).toContain('503');
  expect((await service.prepare('en', 'whisperkit')).error).toBeNull();
});
supported('routes transcription to the chosen engine with the vocabulary and never downloads to do it', async () => {
  const request = vi.spyOn(SpeechClient.prototype, 'request').mockResolvedValue({ result: transcript('whisperkit'), elapsedMs: 1 });
  const service = new NativeSpeechService('/usr/bin/true', '/fixture/models', '/fixture/whisperkit');
  await expect(service.transcribe('/fixture/audio.m4a', 'en', { engine: 'whisperkit' })).rejects.toThrow('Download the WhisperKit model in Settings');
  expect(request).not.toHaveBeenCalled();
  expect(installWhisperModels).not.toHaveBeenCalled();
  whisper.ready = true;
  const result = await service.transcribe('/fixture/audio.m4a', 'de-DE', { engine: 'whisperkit', vocabulary: ['SLSA', 'Priya'] });
  expect(result.provider).toBe('whisperkit');
  expect(request).toHaveBeenCalledWith('transcribe',
    { audioPath: '/fixture/audio.m4a', locale: 'de-DE', engine: 'whisperkit', modelFolder: '/fixture/whisperkit', contextualStrings: ['SLSA', 'Priya'] },
    expect.objectContaining({ timeoutMs: 3 * 60 * 60_000 }));
});
supported('keeps Apple speech as the default and passes it the vocabulary as context', async () => {
  const request = vi.spyOn(SpeechClient.prototype, 'request').mockResolvedValue({ result: transcript('apple'), elapsedMs: 1 });
  const service = new NativeSpeechService('/usr/bin/true', '/fixture/models', '/fixture/whisperkit');
  await service.transcribe('/fixture/audio.m4a', 'en');
  expect(request).toHaveBeenLastCalledWith('transcribe', { audioPath: '/fixture/audio.m4a', locale: 'en-US' }, expect.anything());
  expect(JSON.stringify(request.mock.calls.at(-1)![1])).not.toContain('engine');
  await service.transcribe('/fixture/audio.m4a', 'en', { vocabulary: ['SLSA'] });
  expect(request).toHaveBeenLastCalledWith('transcribe', { audioPath: '/fixture/audio.m4a', locale: 'en-US', contextualStrings: ['SLSA'] }, expect.anything());
});
supported('rejects an answer from a different engine than the one that was asked', async () => {
  vi.spyOn(SpeechClient.prototype, 'request').mockResolvedValue({ result: transcript('apple'), elapsedMs: 1 });
  whisper.ready = true;
  const service = new NativeSpeechService('/usr/bin/true', '/fixture/models', '/fixture/whisperkit');
  await expect(service.transcribe('/fixture/audio.m4a', 'en', { engine: 'whisperkit' })).rejects.toThrow('different transcription engine');
});
