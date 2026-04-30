// electron/main/lib/chunk-wav.test.ts
//
// Verifies the size-threshold gate. The actual ffmpeg-driven slicing
// only kicks in for files over CHUNK_SIZE_THRESHOLD; we don't generate
// 100+ MB fixtures in the test suite, so the slicing path is exercised
// end-to-end via the transcribing stage in manual smoke tests.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chunkWavIfNeeded, CHUNK_SIZE_THRESHOLD } from './chunk-wav.js';

describe('chunkWavIfNeeded', () => {
  it('returns a single passthrough chunk for files under the threshold', async () => {
    const tmp = path.join(os.tmpdir(), `mn-chunk-test-${Date.now()}.wav`);
    // 1 KB stub — the function only checks file size, not WAV validity,
    // when the size is under the threshold.
    fs.writeFileSync(tmp, Buffer.alloc(1024));
    try {
      const chunks = await chunkWavIfNeeded(tmp);
      expect(chunks).toHaveLength(1);
      expect(chunks[0]!.path).toBe(tmp);
      expect(chunks[0]!.startS).toBe(0);
      // No-op cleanup must not delete the source file.
      chunks[0]!.cleanup();
      expect(fs.existsSync(tmp)).toBe(true);
    } finally {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    }
  });

  it('threshold is large enough for typical short meetings', () => {
    // 30 min of 16 kHz mono s16 PCM = 30 * 60 * 32 KB = 57.6 MB.
    // Should comfortably fit in one piece — no chunking should kick in.
    const sizeFor30Min = 30 * 60 * 16000 * 2;
    expect(sizeFor30Min).toBeLessThan(CHUNK_SIZE_THRESHOLD);
  });

  it('threshold catches the long-meeting WAV that triggered the original 413', () => {
    // 75 min of 16 kHz mono s16 PCM = 75 * 60 * 32 KB = 144 MB.
    // Confirms the threshold is actually below this size so chunking
    // engages for the original repro case.
    const sizeFor75Min = 75 * 60 * 16000 * 2;
    expect(sizeFor75Min).toBeGreaterThan(CHUNK_SIZE_THRESHOLD);
  });
});
