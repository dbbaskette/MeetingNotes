import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Prevent ensureWav from shelling out to ffmpeg in tests — the audio files
// are stubs. The no-op mock returns the original path unchanged.
vi.mock('../../lib/ensure-wav.js', () => ({
  ensureWav: async (p: string) => ({ path: p, cleanup: () => {} }),
}));

import { runTranscribing } from './transcribing.js';

describe('runTranscribing', () => {
  it('calls the STT client transcribe and writes transcript.raw.json', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-t-'));
    const mFolder = path.join(dir, 'meetings', 'slug');
    fs.mkdirSync(mFolder, { recursive: true });
    fs.writeFileSync(path.join(mFolder, 'audio.mp3'), 'x');

    const ctx: any = {
      libraryRoot: dir,
      stt: {
        transcribe: vi.fn(async () => ({
          text: 'hi',
          segments: [{ start: 0, end: 1, text: 'hi' }],
        })),
      },
      settings: { get: (k: string) => (k === 'sttModel' ? 'whisper-large-v3' : 'en') },
      meetings: {
        findById: () => ({ slug: 'slug', audioPath: path.join(mFolder, 'audio.mp3') }),
        updateStage: vi.fn(),
      },
      logger: { info: vi.fn(), error: vi.fn() },
    };
    await runTranscribing({ meetingId: 'm1' }, ctx);
    const written = JSON.parse(fs.readFileSync(path.join(mFolder, 'transcript.raw.json'), 'utf8'));
    expect(written.text).toBe('hi');
  });

  it('transcribes voice + system stems independently when both exist', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-t-stem-'));
    const mFolder = path.join(dir, 'meetings', 'slug');
    fs.mkdirSync(mFolder, { recursive: true });
    // Mixed + both stems on disk — triggers the stem-aware path.
    const mixed = path.join(mFolder, 'rec.m4a');
    fs.writeFileSync(mixed, 'x');
    fs.writeFileSync(path.join(mFolder, 'rec.voice.m4a'), 'x');
    fs.writeFileSync(path.join(mFolder, 'rec.system.m4a'), 'x');

    const transcribe = vi.fn(async ({ audioPath }: { audioPath: string }) => {
      // Return distinct segments per stream so we can verify merging.
      if (audioPath.includes('.voice.')) {
        return { text: 'hey', segments: [{ start: 0, end: 2, text: 'hey' }] };
      }
      return { text: 'hi', segments: [{ start: 1, end: 3, text: 'hi' }] };
    });
    const ctx: any = {
      libraryRoot: dir,
      stt: { transcribe },
      settings: { get: (k: string) => (k === 'sttModel' ? 'whisper-large-v3' : 'en') },
      meetings: {
        findById: () => ({ slug: 'slug', audioPath: mixed, durationS: 10 }),
        updateStage: vi.fn(),
      },
      logger: { info: vi.fn(), error: vi.fn() },
    };
    await runTranscribing({ meetingId: 'm1' }, ctx);

    // Separate per-stem files written…
    const voice = JSON.parse(fs.readFileSync(path.join(mFolder, 'transcript.voice.raw.json'), 'utf8'));
    const system = JSON.parse(fs.readFileSync(path.join(mFolder, 'transcript.system.raw.json'), 'utf8'));
    expect(voice.segments[0].text).toBe('hey');
    expect(system.segments[0].text).toBe('hi');

    // …plus a combined transcript.raw.json with source markers, ordered by start.
    const combined = JSON.parse(fs.readFileSync(path.join(mFolder, 'transcript.raw.json'), 'utf8'));
    expect(combined.segments).toEqual([
      { start: 0, end: 2, text: 'hey', source: 'voice' },
      { start: 1, end: 3, text: 'hi', source: 'system' },
    ]);

    // Called twice — once per stem — with the actual stem paths, not the mixed.
    expect(transcribe).toHaveBeenCalledTimes(2);
  });

  it('drops Whisper hallucinations past the known audio duration', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-t-'));
    const mFolder = path.join(dir, 'meetings', 'slug');
    fs.mkdirSync(mFolder, { recursive: true });
    fs.writeFileSync(path.join(mFolder, 'audio.mp3'), 'x');

    const ctx: any = {
      libraryRoot: dir,
      stt: {
        transcribe: vi.fn(async () => ({
          text: 'real content. thanks for watching',
          segments: [
            { start: 0, end: 10, text: 'real content' },
            { start: 12, end: 14, text: 'thanks for watching' }, // hallucination past EOA
          ],
        })),
      },
      settings: { get: (k: string) => (k === 'sttModel' ? 'whisper-large-v3' : 'en') },
      meetings: {
        findById: () => ({ slug: 'slug', audioPath: path.join(mFolder, 'audio.mp3'), durationS: 11 }),
        updateStage: vi.fn(),
      },
      logger: { info: vi.fn(), error: vi.fn() },
    };
    await runTranscribing({ meetingId: 'm1' }, ctx);
    const written = JSON.parse(fs.readFileSync(path.join(mFolder, 'transcript.raw.json'), 'utf8'));
    expect(written.segments).toHaveLength(1);
    expect(written.segments[0].text).toBe('real content');
  });
});
