import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runMerging } from './merging';

describe('runMerging', () => {
  it('reads transcript.raw.json + diarization.json, writes transcript.md', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-m-'));
    const f = path.join(dir, 'meetings', 'slug');
    fs.mkdirSync(f, { recursive: true });
    fs.writeFileSync(
      path.join(f, 'transcript.raw.json'),
      JSON.stringify({
        text: 'Hi. There.',
        segments: [
          { start: 0, end: 1, text: 'Hi.' },
          { start: 1, end: 2, text: 'There.' },
        ],
      }),
    );
    fs.writeFileSync(
      path.join(f, 'diarization.json'),
      JSON.stringify({
        segments: [
          { start: 0, end: 1.2, speaker: 'SPEAKER_00', embedding: [] },
          { start: 1.2, end: 3, speaker: 'SPEAKER_01', embedding: [] },
        ],
        num_speakers: 2,
      }),
    );
    const ctx: any = {
      libraryRoot: dir,
      meetings: { findById: () => ({ slug: 'slug' }) },
      logger: { info: () => {} },
    };
    await runMerging({ meetingId: 'm' }, ctx);
    const md = fs.readFileSync(path.join(f, 'transcript.md'), 'utf8');
    expect(md).toContain('[SPEAKER_00 00:00] Hi.');
    expect(md).toContain('[SPEAKER_01 00:01] There.');
  });
});
