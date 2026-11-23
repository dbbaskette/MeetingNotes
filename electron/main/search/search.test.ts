import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SearchOwners } from './owners.js';
import { ripgrepSearchDetailed } from './ripgrep-search.js';
import { FacetsSchema } from './facets.js';
describe('owned search', () => {
  it('scans only eligible folders, including an empty scope and a multi-batch scope', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-scoped-search-'));
    try {
      const folders = Array.from({ length: 130 }, (_, i) => path.join(root, String(i)));
      for (const folder of folders) { fs.mkdirSync(folder); fs.writeFileSync(path.join(folder, 'summary.md'), 'needle'); }
      expect((await ripgrepSearchDetailed(root, 'needle', { paths: [] })).matches).toEqual([]);
      expect((await ripgrepSearchDetailed(root, 'needle', { paths: folders.slice(0, 2) })).matches).length(2);
      expect((await ripgrepSearchDetailed(root, 'needle', { paths: folders })).matches).length(130);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  it('bounds real subprocess concurrency during a rapid burst and cancels a running child', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-search-burst-'));
    try {
      fs.writeFileSync(
        path.join(root, 'transcript.md'),
        'Synthetic long searchable content.\n'.repeat(300000),
      );
      // ripgrep given a FIFO with no writer blocks in open() forever, so a
      // child searching it is guaranteed to still be running until it is
      // killed. A large file only made that likely: a fast scan could finish
      // before a 0 ms timeout fired and the search came back 'complete'.
      const blocked = path.join(root, 'blocked.md');
      execFileSync('mkfifo', [blocked]);
      const owners = new SearchOwners();
      let live = 0,
        maximum = 0,
        spawned = 0;
      const track = (state: 'started' | 'closed'): void => {
        if (state === 'started') spawned++;
        live += state === 'started' ? 1 : -1;
        maximum = Math.max(maximum, live);
      };
      const search = async (index: number, target: string): Promise<string> => {
        const owner = await owners.begin(1, 'burst', index + 1);
        try {
          return (await ripgrepSearchDetailed(target, 'absent', {
            signal: owner.signal, onProcess: track, timeoutMs: 30_000,
          })).status;
        } finally {
          owner.finish();
        }
      };
      const until = async (check: () => boolean): Promise<void> => {
        while (!check()) await new Promise((resolve) => setTimeout(resolve, 5));
      };

      // Rapid burst: every request is superseded before it can start, so only
      // the newest one may spawn a child, and it runs to completion.
      const burst = await Promise.all(Array.from({ length: 30 }, (_, i) => search(i, root)));
      expect(burst.slice(0, 29)).toEqual(Array(29).fill('cancelled'));
      expect(burst[29]).toBe('complete');
      expect(maximum).toBeLessThanOrEqual(1);
      expect(live).toBe(0);

      // Staged burst: each request starts a child that can never finish on
      // its own before the next request supersedes it. The replacement must
      // wait for that child to exit, so live children never exceed one.
      const staged: Array<Promise<string>> = [];
      const before = spawned;
      for (let i = 0; i < 5; i++) {
        staged.push(search(30 + i, blocked));
        await until(() => spawned === before + i + 1);
      }
      staged.push(search(35, root));
      const stagedStatus = await Promise.all(staged);
      expect(stagedStatus).toEqual([...Array(5).fill('cancelled'), 'complete']);
      expect(spawned).toBe(before + 6);
      expect(maximum).toBe(1);
      expect(live).toBe(0);

      // A running child is really killed on abort, and a timeout reports the
      // results as partial rather than waiting for the child.
      const abort = new AbortController();
      let closed = false;
      const cancelled = ripgrepSearchDetailed(blocked, 'absent', {
        signal: abort.signal,
        onProcess: (state) => {
          if (state === 'started') setTimeout(() => abort.abort(), 20);
          else closed = true;
        },
      });
      expect((await cancelled).status).toBe('cancelled');
      expect(closed).toBe(true);
      expect((await ripgrepSearchDetailed(blocked, 'absent', { timeoutMs: 0 })).status).toBe(
        'partial',
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it('waits for its obsolete child, fences cancellation IDs and leaves other clients alone', async () => {
    const owners = new SearchOwners(),
      first = await owners.begin(1, 'library', 1),
      palette = await owners.begin(1, 'palette', 1);
    let ready = false;
    const next = owners.begin(1, 'library', 2).then((owner) => {
      ready = true;
      return owner;
    });
    await Promise.resolve();
    expect(first.signal.aborted).toBe(true);
    expect(palette.signal.aborted).toBe(false);
    expect(ready).toBe(false);
    first.finish();
    const second = await next;
    owners.cancel(1, 'library', 1);
    expect(second.signal.aborted).toBe(false);
    owners.cancel(1, 'library', 2);
    expect(second.signal.aborted).toBe(true);
    second.finish();
    owners.destroy(1);
    expect(palette.signal.aborted).toBe(true);
    palette.finish();
  });
  it('reports no-match, bounded, failed and cancelled results truthfully', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-search-'));
    try {
      fs.writeFileSync(path.join(root, 'summary.md'), 'needle\nneedle\nneedle\n');
      expect((await ripgrepSearchDetailed(root, 'absent')).status).toBe('complete');
      expect((await ripgrepSearchDetailed(root, 'needle', { maxTotalMatches: 1 })).status).toBe(
        'limit',
      );
      expect((await ripgrepSearchDetailed(path.join(root, 'missing'), 'needle')).status).toBe(
        'failed',
      );
      const abort = new AbortController();
      abort.abort();
      expect(await ripgrepSearchDetailed(root, 'needle', { signal: abort.signal })).toEqual({
        matches: [],
        status: 'cancelled',
      });
      expect(
        (
          await ripgrepSearchDetailed(root, 'needle', {
            acceptFile: () => false,
            maxTotalMatches: 1,
          })
        ).matches,
      ).toEqual([]);
      expect((await ripgrepSearchDetailed(root, '--needle')).status).toBe('complete');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it('rejects unknown facets and invalid weeks', () => {
    expect(FacetsSchema.safeParse({ status: 'bogus' }).success).toBe(false);
    expect(FacetsSchema.safeParse({ week: '2026-W54' }).success).toBe(false);
    expect(FacetsSchema.safeParse({ week: '2026-W53' }).success).toBe(true);
    expect(FacetsSchema.safeParse({ week: '2025-W53' }).success).toBe(false);
    expect(FacetsSchema.safeParse({ from: '2026-02-31' }).success).toBe(false);
    expect(FacetsSchema.safeParse({ from: '2026-10-09', to: '2026-10-01' }).success).toBe(false);
    expect(FacetsSchema.safeParse({ unsafe: true }).success).toBe(false);
  });
});
