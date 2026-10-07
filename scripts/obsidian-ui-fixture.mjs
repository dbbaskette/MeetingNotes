// Opt-in synthetic renderer only. Never starts MeetingNotes main or reads user data.
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
const root = fileURLToPath(new URL('..', import.meta.url));
const server = await createServer({ configFile: false, root, plugins: [react()], server: { host: '127.0.0.1', port: 5199, strictPort: true } });
try {
  await server.listen();
  await new Promise((resolve, reject) => {
    const child = spawn(electron, [`${root}/scripts/obsidian-ui-fixture/runner.cjs`], { cwd: root, stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '', MN_OBSIDIAN_FIXTURE_URL: `${server.resolvedUrls.local[0]}scripts/obsidian-ui-fixture/index.html` } });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(Error(`Fixture exited ${code}`)));
  });
} finally { await server.close(); }
