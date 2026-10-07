import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SearchOwners } from './owners.js';
import { ripgrepSearchDetailed } from './ripgrep-search.js';
import { FacetsSchema } from './facets.js';
describe('owned search', () => {
  it('bounds real subprocess concurrency during a rapid burst and cancels a running child', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-search-burst-'));
    try {
      fs.writeFileSync(
        path.join(root, 'transcript.md'),
        'Synthetic long searchable content.\n'.repeat(300000),
      );
      const owners = new SearchOwners();
      let live = 0,
        maximum = 0,
        cancelled = 0;
      const started = performance.now();
      await Promise.all(
        Array.from({ length: 30 }, async (_, index) => {
          const owner = await owners.begin(1, 'burst', index + 1);
          try {
            const result = await ripgrepSearchDetailed(root, 'absent', {
              signal: owner.signal,
              onProcess: (state) => {
                live += state === 'started' ? 1 : -1;
                maximum = Math.max(maximum, live);
              },
            });
            if (result.status === 'cancelled') cancelled++;
          } finally {
            owner.finish();
          }
        }),
      );
      expect(maximum).toBe(1);
      expect(live).toBe(0);
      expect(cancelled).toBe(29);
      const abort = new AbortController();
      const result = await ripgrepSearchDetailed(root, 'absent', {
        signal: abort.signal,
        onProcess: (state) => {
          if (state === 'started') abort.abort();
        },
      });
      expect(result.status).toBe('cancelled');
      expect((await ripgrepSearchDetailed(root, 'absent', { timeoutMs: 0 })).status).toBe(
        'partial',
      );
      console.log(
        'Search burst: 30 requests, maximum 1 child, 29 cancelled, elapsed ms',
        Math.round(performance.now() - started),
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
