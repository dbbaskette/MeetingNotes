// Synthetic warm-filesystem comparison; no user Library is opened.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ripgrepSearchDetailed } from '../electron/main/search/ripgrep-search.ts';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-search-scope-bench-'));
try {
  const folders = Array.from({ length: 500 }, (_, i) => path.join(root, `meeting-${i}`));
  const text = 'Synthetic meeting discussion and follow-up.\n'.repeat(6000);
  for (const folder of folders) { fs.mkdirSync(folder); fs.writeFileSync(path.join(folder, 'transcript.md'), text); }
  const selected = new Set(folders.slice(0, 10)), before = [], after = [];
  for (let trial = 0; trial < 7; trial++) {
    for (const scoped of [false, true]) {
      const start = performance.now();
      const result = await ripgrepSearchDetailed(root, 'not-present-anywhere', { timeoutMs: 10000, globs: ['transcript.md'],
        acceptFile: file => selected.has(path.dirname(file)), ...(scoped ? { paths: [...selected] } : {}) });
      if (result.status !== 'complete' || result.matches.length) throw new Error('Search correctness failed');
      (scoped ? after : before).push(performance.now() - start);
    }
  }
  const median = values => Number([...values].sort((a, b) => a - b)[3].toFixed(2));
  console.log(JSON.stringify({ filesBefore: folders.length, filesAfter: selected.size, medianBeforeMs: median(before), medianAfterMs: median(after), trials: 7,
    limitation: 'Synthetic warm-filesystem fixed-string no-match search, 500 transcripts; not a production latency guarantee.' }));
} finally { fs.rmSync(root, { recursive: true, force: true }); }
