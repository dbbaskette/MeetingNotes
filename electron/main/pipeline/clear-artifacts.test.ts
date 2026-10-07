import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ArtifactCache } from '../library/artifact-cache.js';
import { clearArtifactsFromStage } from './clear-artifacts.js';

describe('clearArtifactsFromStage', () => {
  it('invalidates the whole meeting folder before removal and refreshes same-fingerprint replacements', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-clear-cache-'));
    try {
      const folder = path.join(root, 'meeting');
      const neighbor = path.join(root, 'meeting-other');
      fs.mkdirSync(folder);
      fs.mkdirSync(neighbor);
      const summaryPath = path.join(folder, 'summary.md');
      const rawPath = path.join(folder, 'transcript.raw.json');
      const neighborPath = path.join(neighbor, 'summary.md');
      fs.writeFileSync(summaryPath, 'old summary');
      fs.writeFileSync(rawPath, 'old raw');
      fs.writeFileSync(neighborPath, 'other summary');
      const artifactCache = new ArtifactCache({
        stat: async (filePath) => ({ size: fs.statSync(filePath).size, mtimeMs: 1, ctimeMs: 1 }),
      });
      await Promise.all([summaryPath, rawPath, neighborPath].map((filePath) => artifactCache.readText(filePath)));
      const rmSync = fs.rmSync.bind(fs);
      const entriesAtRemoval: number[] = [];
      const remove = vi.spyOn(fs, 'rmSync').mockImplementation((...args) => {
        entriesAtRemoval.push(artifactCache.stats().entries);
        return rmSync(...args);
      });
      try {
        clearArtifactsFromStage(folder, 'summarizing', artifactCache);
      } finally {
        remove.mockRestore();
      }
      expect(fs.existsSync(summaryPath)).toBe(false);
      expect(fs.readFileSync(rawPath, 'utf8')).toBe('old raw');
      fs.writeFileSync(summaryPath, 'new summary');
      fs.writeFileSync(rawPath, 'new raw');
      expect(await artifactCache.readText(summaryPath)).toBe('new summary');
      expect(await artifactCache.readText(rawPath)).toBe('new raw');
      expect(entriesAtRemoval).toEqual([1, 1]);
      expect(await artifactCache.readText(neighborPath)).toBe('other summary');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
