// Electron entry point for `npm run smoke:source`.
//
// Starts the real built main process against the synthetic package-smoke
// fixture without packaging first. The app is told it is packaged so it loads
// the built renderer (with its production Content-Security-Policy) instead of
// the Vite dev server, and so the existing package-smoke assertions run.
//
// This is a fast local check that the app still starts and renders. It is not
// a substitute for the packaged gate in scripts/ci/package-smoke.sh: helper,
// sidecar and resource paths resolve differently in a real bundle.
import { app } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.argv[2];
if (!root) throw new Error('Pass the repository root');
Object.defineProperty(app, 'isPackaged', { get: () => true });
app.setAppPath(root);
// Awaited at top level so the main module finishes its pre-ready setup
// (protocol registration) before Electron emits `ready`.
await import(pathToFileURL(path.join(root, 'dist/electron/main/index.js')).href);
