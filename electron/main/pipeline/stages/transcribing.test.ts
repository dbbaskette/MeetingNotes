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
