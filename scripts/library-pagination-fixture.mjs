// Standalone, opt-in. Starts only this synthetic renderer, never the app main.
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import electron from 'electron';

const root = fileURLToPath(new URL('..', import.meta.url));
const modes = ['rows', 'selection', 'grouped', 'startup', 'settings', 'sources', 'capture', 'epic243', 'terminology'];
const selected = process.env.MN_FIXTURE_MODES?.split(',') ?? modes;
if (selected.some(mode => !modes.includes(mode))) throw new Error('Unknown fixture mode');
const baselinePath = path.join(root, 'electron/renderer/src/views/.epic243-baseline-transcript.tsx');
let ownsBaseline = false;
if (selected.includes('epic243')) {
  const baseline = execFileSync('git', ['show', '1be1704:electron/renderer/src/views/MeetingTranscriptPanel.tsx'], { cwd: process.env.MN_BENCH_REPO ?? root });
  fs.writeFileSync(baselinePath, baseline, { flag: 'wx' });
  ownsBaseline = true;
}
const server = await createServer({ configFile: false, root, plugins: [react()],
  // The final capture fixture uses Markdown recovery details. Pre-optimize
  // those dependencies so a cold run does not reload its assertion sequence.
  optimizeDeps: { include: ['react-markdown', 'remark-gfm'] },
  server: { host: '127.0.0.1', port: 5198, strictPort: true } });
try {
  await server.listen();
  const origin = server.resolvedUrls.local[0];
  for (const mode of selected) {
    const entry = mode === 'rows' ? 'index.html' : `${mode}.html`;
    await new Promise((resolve, reject) => {
      const child = spawn(electron, [path.join(root, `scripts/library-pagination-fixture/${mode}.cjs`)], {
        cwd: root, stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '',
          MN_LIBRARY_FIXTURE_URL: `${origin}scripts/library-pagination-fixture/${entry}` },
      });
      const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${mode} fixture exceeded 120 seconds`)); }, 120000);
      child.once('error', (error) => { clearTimeout(timeout); reject(error); });
      child.once('exit', (code) => { clearTimeout(timeout); code === 0 ? resolve() : reject(new Error(`${mode} fixture exited ${code}`)); });
    });
  }
} finally { await server.close(); if (ownsBaseline) fs.unlinkSync(baselinePath); }
