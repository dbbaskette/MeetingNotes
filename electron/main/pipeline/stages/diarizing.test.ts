import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Prevent ensureWav from shelling out to ffmpeg in tests — the audio path
// is a stub. The no-op mock returns the original path unchanged.
vi.mock('../../lib/ensure-wav.js', () => ({
  ensureWav: async (p: string) => ({ path: p, cleanup: () => {} }),
}));

import { runDiarizing } from './diarizing.js';

describe('runDiarizing', () => {
  it('calls diarization client and writes diarization.json', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-d-'));
    const mFolder = path.join(dir, 'meetings', 'slug');
    fs.mkdirSync(mFolder, { recursive: true });

    const ctx: any = {
      libraryRoot: dir,
      diarization: {
        diarize: vi.fn(async () => ({
          segments: [
            { start: 0, end: 1, speaker: 'SPEAKER_00', embedding: new Array(512).fill(0) },
          ],
          num_speakers: 1,
        })),
      },
      meetings: { findById: () => ({ slug: 'slug', audioPath: '/x.mp3' }) },
      logger: { info: vi.fn() },
    };
    await runDiarizing({ meetingId: 'm' }, ctx);
    const got = JSON.parse(fs.readFileSync(path.join(mFolder, 'diarization.json'), 'utf8'));
    expect(got.num_speakers).toBe(1);
  });

  it('diarizes the system stem (not the mixed file) when stems exist', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-d-stem-'));
    const mFolder = path.join(dir, 'meetings', 'slug');
    fs.mkdirSync(mFolder, { recursive: true });
    // Place a mixed file + system + voice stems on disk to trigger stem-aware path.
    const mixed = path.join(mFolder, 'rec.m4a');
    const system = path.join(mFolder, 'rec.system.m4a');
    const voice = path.join(mFolder, 'rec.voice.m4a');
    fs.writeFileSync(mixed, 'x');
    fs.writeFileSync(system, 'x');
    fs.writeFileSync(voice, 'x');

    const diarize = vi.fn(async () => ({
      segments: [{ start: 0, end: 1, speaker: 'SPEAKER_00', embedding: new Array(512).fill(0) }],
      num_speakers: 1,
    }));
    const ctx: any = {
      libraryRoot: dir,
      diarization: { diarize },
      meetings: { findById: () => ({ slug: 'slug', audioPath: mixed }) },
      logger: { info: vi.fn() },
    };
    await runDiarizing({ meetingId: 'm' }, ctx);
    // Must have diarized the SYSTEM stem, not the mixed file.
    expect(diarize).toHaveBeenCalledTimes(1);
    expect(diarize.mock.calls[0][0]).toBe(system);
  });
});
