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
});
