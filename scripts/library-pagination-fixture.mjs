// Standalone, opt-in. Starts only this synthetic renderer, never the app main.
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import electron from 'electron';

const root = fileURLToPath(new URL('..', import.meta.url));
const server = await createServer({ configFile: false, root, plugins: [react()],
  server: { host: '127.0.0.1', port: 5198, strictPort: true } });
try {
  await server.listen();
  const origin = server.resolvedUrls.local[0];
  for (const mode of ['rows', 'selection']) {
    const entry = mode === 'rows' ? 'index.html' : 'selection.html';
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
} finally { await server.close(); }
