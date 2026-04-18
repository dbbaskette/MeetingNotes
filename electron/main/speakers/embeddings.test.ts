import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeEmbedding, readEmbedding, embeddingFilePath } from './embeddings.js';

const dirs: string[] = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

describe('embeddings', () => {
  it('writes and reads a 512-float vector round-trip', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-emb-')); dirs.push(dir);
    const vec = Array.from({ length: 512 }, (_, i) => i * 0.001);
    const file = embeddingFilePath(dir, 'spk_x1');
    writeEmbedding(file, vec);
    const got = readEmbedding(file);
    expect(got).toHaveLength(512);
    expect(got[10]).toBeCloseTo(vec[10]!, 6);
  });

  it('rejects wrong magic bytes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-emb2-')); dirs.push(dir);
    const f = path.join(dir, 'bad.bin');
    fs.writeFileSync(f, Buffer.from('XXX'));
    expect(() => readEmbedding(f)).toThrow(/magic|format/i);
  });
});
