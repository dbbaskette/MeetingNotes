import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LibraryWatcher } from './watcher.js';

const dirs: string[] = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

describe('LibraryWatcher', () => {
  it('emits a stable-file event once the file size stops changing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-watch-')); dirs.push(dir);
    const w = new LibraryWatcher({ path: dir, stabilityMs: 100, pollMs: 40 });
    const seen: string[] = [];
    w.onStableFile((p) => seen.push(p));
    await w.start();
    const file = path.join(dir, 'new.mp3');
    fs.writeFileSync(file, Buffer.alloc(100));
    await new Promise((r) => setTimeout(r, 400));
    await w.stop();
    expect(seen).toContain(file);
  });

  it('emits already-existing .mp3 files on start (initial scan)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-watch-init-')); dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'a.mp3'), Buffer.alloc(10));
    fs.writeFileSync(path.join(dir, 'b.mp3'), Buffer.alloc(10));
    fs.writeFileSync(path.join(dir, 'ignore.txt'), 'no');
    const w = new LibraryWatcher({ path: dir, stabilityMs: 50, pollMs: 30 });
    const seen: string[] = [];
    w.onStableFile((p) => seen.push(p));
    await w.start();
    await w.stop();
    expect(seen.sort()).toEqual([path.join(dir, 'a.mp3'), path.join(dir, 'b.mp3')]);
  });

  it('does not double-emit a file across initial scan + add event', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-watch-dedupe-')); dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'pre.mp3'), Buffer.alloc(10));
    const w = new LibraryWatcher({ path: dir, stabilityMs: 50, pollMs: 30 });
    const seen: string[] = [];
    w.onStableFile((p) => seen.push(p));
    await w.start();
    // touch existing file — chokidar may emit add/change; either way we shouldn't re-fire.
    fs.utimesSync(path.join(dir, 'pre.mp3'), new Date(), new Date());
    await new Promise((r) => setTimeout(r, 200));
    await w.stop();
    expect(seen.filter((p) => p.endsWith('pre.mp3'))).toHaveLength(1);
  });

  it('filters to .mp3 only', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-watch2-')); dirs.push(dir);
    const w = new LibraryWatcher({ path: dir, stabilityMs: 80, pollMs: 40 });
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
    const w = new LibraryWatcher({ path: dir, stabilityMs: 80, pollMs: 40 });
    const seen: string[] = [];
    w.onStableFile((p) => seen.push(p));
    await w.start();
    const newFile = path.join(dir, 'new.m4a');
    fs.writeFileSync(newFile, Buffer.alloc(50));
    await new Promise((r) => setTimeout(r, 350));
    await w.stop();
    expect(seen).toContain(path.join(dir, 'pre.m4a'));
    expect(seen).toContain(newFile);
  });

  it('watches multiple paths when configured', async () => {
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-watch-a-')); dirs.push(dirA);
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-watch-b-')); dirs.push(dirB);
    fs.writeFileSync(path.join(dirA, 'a.m4a'), Buffer.alloc(10));
    fs.writeFileSync(path.join(dirB, 'b.mp3'), Buffer.alloc(10));
    const w = new LibraryWatcher({ paths: [dirA, dirB], stabilityMs: 80, pollMs: 40 });
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
    });
    const seen: string[] = [];
    w.onStableFile((p) => seen.push(p));
    await w.start();
    await w.stop();
    expect(seen).toContain(path.join(dir, 'a.mp3'));
  });
});
