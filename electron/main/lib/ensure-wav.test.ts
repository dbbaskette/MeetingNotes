import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureWav } from './ensure-wav.js';

describe('ensureWav', () => {
  it('returns input path unchanged for .wav files (no-op cleanup)', async () => {
    const wav = path.join(os.tmpdir(), `test-${Date.now()}.wav`);
    fs.writeFileSync(wav, Buffer.alloc(8));
    try {
      const result = await ensureWav(wav);
      expect(result.path).toBe(wav);
      result.cleanup(); // should not throw or delete the original
      expect(fs.existsSync(wav)).toBe(true);
    } finally {
      fs.unlinkSync(wav);
    }
  });
});
