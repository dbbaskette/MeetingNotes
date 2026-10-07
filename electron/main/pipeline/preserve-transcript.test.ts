import { it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { preserveTranscript } from './preserve-transcript.js';
it('keeps manual corrections in distinct local snapshots before replacing transcript stages', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-transcript-history-'));
  try {
    fs.writeFileSync(path.join(dir, 'transcript.md'), 'SLSA corrected by user');
    expect(preserveTranscript(dir, 'summarizing')).toBeNull();
    const a = preserveTranscript(dir, 'transcribing')!, b = preserveTranscript(dir, 'diarizing')!;
    expect(a).not.toBe(b); expect(fs.readFileSync(path.join(dir, a), 'utf8')).toBe('SLSA corrected by user');
    expect(fs.readFileSync(path.join(dir, 'transcript.md'), 'utf8')).toBe('SLSA corrected by user');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
