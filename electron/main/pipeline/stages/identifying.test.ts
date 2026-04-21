import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runIdentifying } from './identifying.js';

describe('runIdentifying', () => {
  it('averages embeddings per speaker and links via roster service', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-i-'));
    const f = path.join(dir, 'meetings', 'slug');
    fs.mkdirSync(f, { recursive: true });
    fs.writeFileSync(
      path.join(f, 'diarization.json'),
      JSON.stringify({
        segments: [
          { start: 0, end: 1, speaker: 'SPEAKER_00', embedding: [1, 0, 0] },
          { start: 1, end: 2, speaker: 'SPEAKER_00', embedding: [1, 0, 0] },
          { start: 2, end: 3, speaker: 'SPEAKER_01', embedding: [0, 1, 0] },
        ],
        num_speakers: 2,
      }),
    );
    const linkFn = vi.fn();
    const ctx: any = {
      libraryRoot: dir,
      meetings: { findById: () => ({ slug: 'slug' }) },
      roster: {
        identifyUnknowns: vi.fn(() => [
          { label: 'SPEAKER_00', rosterId: 'spk_a', confidence: 0.9 },
          { label: 'SPEAKER_01', rosterId: null, confidence: null },
        ]),
      },
      // Empty listForMeeting simulates a fresh run (no prior user assignments)
      // — identifying should write every auto-match without being told to
      // skip any.
      speakers: { linkToMeeting: linkFn, listForMeeting: () => [] },
      logger: { info: () => {} },
    };
    await runIdentifying({ meetingId: 'm' }, ctx);
    expect(linkFn).toHaveBeenCalledWith('m', 'SPEAKER_00', 'spk_a', 0.9);
  });
});
