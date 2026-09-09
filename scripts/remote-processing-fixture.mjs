// Standalone, opt-in validation. Starts only an isolated synthetic renderer and
// an Electron process whose userData/library roots are temporary directories.
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import electron from 'electron';

const root = fileURLToPath(new URL('..', import.meta.url));
const server = await createServer({
  configFile: false,
  root,
  plugins: [react()],
  server: { host: '127.0.0.1', port: 5199, strictPort: true },
});

try {
  await server.listen();
  const origin = server.resolvedUrls.local[0];
  await new Promise((resolve, reject) => {
    const child = spawn(electron, [path.join(root, 'scripts/remote-processing-fixture/runner.cjs')], {
      cwd: root,
      stdio: 'inherit',
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '',
        MN_REMOTE_FIXTURE_URL: `${origin}scripts/remote-processing-fixture/index.html`,
      },
    });
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Remote processing fixture exceeded 120 seconds'));
    }, 120_000);
    child.once('error', (error) => { clearTimeout(timeout); reject(error); });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      code === 0 ? resolve() : reject(new Error(`Remote processing fixture exited ${code}`));
    });
  });
} finally {
  await server.close();
}
