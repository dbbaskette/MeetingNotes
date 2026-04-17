import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LibraryWatcher } from './watcher';

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
});
