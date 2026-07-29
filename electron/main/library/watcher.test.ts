import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LibraryWatcher } from './watcher.js';

const dirs: string[] = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('condition not met before timeout');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('LibraryWatcher', () => {
  it('emits a stable-file event once the file size stops changing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-watch-')); dirs.push(dir);
    const w = new LibraryWatcher({ path: dir, stabilityMs: 100, pollMs: 40, usePolling: true });
    const seen: string[] = [];
    w.onStableFile((p) => seen.push(p));
    await w.start();
    const file = path.join(dir, 'new.mp3');
    fs.writeFileSync(file, Buffer.alloc(100));
    await waitFor(() => seen.includes(file));
    await w.stop();
    expect(seen).toContain(file);
  });

  it('emits already-existing .mp3 files on start (initial scan)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-watch-init-')); dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'a.mp3'), Buffer.alloc(10));
    fs.writeFileSync(path.join(dir, 'b.mp3'), Buffer.alloc(10));
    fs.writeFileSync(path.join(dir, 'ignore.txt'), 'no');
    const w = new LibraryWatcher({ path: dir, stabilityMs: 50, pollMs: 30, usePolling: true });
    const seen: string[] = [];
    w.onStableFile((p) => seen.push(p));
    await w.start();
    await w.stop();
    expect(seen.sort()).toEqual([path.join(dir, 'a.mp3'), path.join(dir, 'b.mp3')]);
  });

  it('skips dual-stem artifacts (*.voice.m4a, *.system.m4a)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-watch-stems-')); dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'rec-001.m4a'), Buffer.alloc(10));        // mixed — should emit
    fs.writeFileSync(path.join(dir, 'rec-001.voice.m4a'), Buffer.alloc(10));  // stem — skip
    fs.writeFileSync(path.join(dir, 'rec-001.system.m4a'), Buffer.alloc(10)); // stem — skip
    const w = new LibraryWatcher({ path: dir, stabilityMs: 50, pollMs: 30, usePolling: true });
    const seen: string[] = [];
    w.onStableFile((p) => seen.push(p));
    await w.start();
    await w.stop();
    expect(seen).toEqual([path.join(dir, 'rec-001.m4a')]);
  });

  it('does not double-emit a file across initial scan + add event', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-watch-dedupe-')); dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'pre.mp3'), Buffer.alloc(10));
    const w = new LibraryWatcher({ path: dir, stabilityMs: 50, pollMs: 30, usePolling: true });
    const seen: string[] = [];
    w.onStableFile((p) => seen.push(p));
    await w.start();
    // A real content change is observed, but successful delivery keeps the
    // path deduplicated.
    fs.appendFileSync(path.join(dir, 'pre.mp3'), Buffer.alloc(10));
    await new Promise((r) => setTimeout(r, 300));
    await w.stop();
    expect(seen.filter((p) => p.endsWith('pre.mp3'))).toHaveLength(1);
  });

  it('emits a changed supported file after a failed path is released', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-watch-release-')); dirs.push(dir);
    const file = path.join(dir, 'unfinished.m4a');
    fs.writeFileSync(file, Buffer.alloc(10));
    const w = new LibraryWatcher({ path: dir, stabilityMs: 80, pollMs: 40, usePolling: true });
    const seen: string[] = [];
    w.onStableFile((p) => seen.push(p));
    await w.start();
    expect(seen).toEqual([file]);

    w.release(file);
    fs.appendFileSync(file, Buffer.alloc(10));
    await waitFor(() => seen.length === 2);
    await w.stop();
    expect(seen).toEqual([file, file]);
  });

  it('continues to ignore changed voice and system stems', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-watch-stem-change-')); dirs.push(dir);
    const voice = path.join(dir, 'rec.voice.m4a');
    const system = path.join(dir, 'rec.system.m4a');
    fs.writeFileSync(voice, Buffer.alloc(10));
    fs.writeFileSync(system, Buffer.alloc(10));
    const w = new LibraryWatcher({ path: dir, stabilityMs: 80, pollMs: 40, usePolling: true });
    const seen: string[] = [];
    w.onStableFile((p) => seen.push(p));
    await w.start();

    fs.appendFileSync(voice, Buffer.alloc(10));
    fs.appendFileSync(system, Buffer.alloc(10));
    await new Promise((r) => setTimeout(r, 300));
    await w.stop();
    expect(seen).toEqual([]);
  });

  it('filters to .mp3 only', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-watch2-')); dirs.push(dir);
    const w = new LibraryWatcher({ path: dir, stabilityMs: 80, pollMs: 40, usePolling: true });
    const seen: string[] = [];
    w.onStableFile((p) => seen.push(p));
    await w.start();
    fs.writeFileSync(path.join(dir, 'x.txt'), 'hi');
    await new Promise((r) => setTimeout(r, 300));
    await w.stop();
    expect(seen.length).toBe(0);
  });

  it('detects .m4a files (built-in capture output)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-watch-m4a-')); dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'pre.m4a'), Buffer.alloc(10));
    const w = new LibraryWatcher({ path: dir, stabilityMs: 80, pollMs: 40, usePolling: true });
    const seen: string[] = [];
    w.onStableFile((p) => seen.push(p));
    await w.start();
    const newFile = path.join(dir, 'new.m4a');
    fs.writeFileSync(newFile, Buffer.alloc(50));
    await waitFor(() => seen.includes(newFile));
    await w.stop();
    expect(seen).toContain(path.join(dir, 'pre.m4a'));
    expect(seen).toContain(newFile);
  });

  it('watches multiple paths when configured', async () => {
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-watch-a-')); dirs.push(dirA);
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-watch-b-')); dirs.push(dirB);
    fs.writeFileSync(path.join(dirA, 'a.m4a'), Buffer.alloc(10));
    fs.writeFileSync(path.join(dirB, 'b.mp3'), Buffer.alloc(10));
    const w = new LibraryWatcher({
      paths: [dirA, dirB], stabilityMs: 80, pollMs: 40, usePolling: true,
    });
    const seen: string[] = [];
    w.onStableFile((p) => seen.push(p));
    await w.start();
    await w.stop();
    expect(seen).toContain(path.join(dirA, 'a.m4a'));
    expect(seen).toContain(path.join(dirB, 'b.mp3'));
  });

  it('skips non-existent watch paths instead of throwing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-watch-real-')); dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'a.mp3'), Buffer.alloc(10));
    const w = new LibraryWatcher({
      paths: [dir, path.join(os.tmpdir(), 'definitely-not-a-real-dir-' + Date.now())],
      stabilityMs: 80, pollMs: 40,
      usePolling: true,
    });
    const seen: string[] = [];
    w.onStableFile((p) => seen.push(p));
    await w.start();
    await w.stop();
    expect(seen).toContain(path.join(dir, 'a.mp3'));
  });
});
