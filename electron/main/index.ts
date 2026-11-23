import { app, BrowserWindow, nativeTheme, protocol, shell } from 'electron';
import { installNavigationGuard } from './lib/navigation-guard.js';
import path from 'node:path';
import fs from 'node:fs';

protocol.registerSchemesAsPrivileged([{ scheme: 'recovery-audio', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } }]);
import { createSplash } from './splash.js';
import { installAppMenu } from './menu.js';
import { packageSmokeRoot, verifyPackageSmoke } from './lib/package-smoke.js';
import { createWindow, logWindow } from './app-window.js';
import { handleSchemeUrl } from './scheme-urls.js';
import { createServices } from './services.js';
import { wireAppSurfaces } from './app-surfaces.js';
import { registerAppIpc } from './app-ipc.js';

const smokeRoot = packageSmokeRoot();
if (smokeRoot) app.setPath('userData', smokeRoot);

// Register meetingnotes:// as our protocol scheme. Doing this before
// app.whenReady() — and before the single-instance lock — so:
//   (a) macOS picks MeetingNotes as the handler from the first launch;
//   (b) `open-url` events that fire during a cold-start (the user did
//       `open meetingnotes://record` while the app wasn't running) are
//       buffered into `pendingSchemeUrls` and replayed once the
//       dispatcher is ready inside whenReady().
// Issue #77.
if (!smokeRoot && !app.isDefaultProtocolClient('meetingnotes')) {
  app.setAsDefaultProtocolClient('meetingnotes');
}
// macOS delivers protocol-handler invocations via this Cocoa event. This
// listener is the primary entry point on Mac; the second-instance fallback
// below is a no-op on Mac but keeps the Windows/Linux argv path covered.
app.on('open-url', (event, url) => {
  event.preventDefault();
  handleSchemeUrl(url);
});

// Links in displayed content must never navigate an app window or open a new
// one; web links go to the default browser instead (#249). Registered before
// any window exists so the splash, main and PDF windows are all covered.
installNavigationGuard(app, {
  openExternal: (url) => shell.openExternal(url),
  log: (msg, data) => logWindow(msg, data),
});

app.whenReady().then(async () => {
  // Splash first — paints within ~100 ms of dock-icon click and stays
  // up through the rest of init (db open, repo construction, IPC
  // registration, library scan, supervisors). Closed in tandem with
  // the real window's ready-to-show below.
  const splash = createSplash();

  // Custom app menu (File → New Recording, View → Library/Weekly/Settings,
  // global Cmd+R / Cmd+K / Cmd+, accelerators). Items emit named menu
  // actions to all renderer windows; AppInner listens via the preload
  // bridge and routes them to local state changes.
  installAppMenu();

  const services = await createServices(smokeRoot);
  const surfaces = wireAppSurfaces(services, smokeRoot);
  registerAppIpc(services, surfaces, smokeRoot);
  const {
    settings, logger, obsidian, watcher, purgeExpiredTrash, pipeline, nativeSpeech, recordingSessionsRepo,
    recordingManager, trashPurgeTimer, llmSupervisor,
  } = services;
  const { meetingDetector, nativeAppDetector } = surfaces;

  const themeChoice = settings.get('theme');
  nativeTheme.themeSource = themeChoice;
  const winBg = nativeTheme.shouldUseDarkColors ? '#171615' : '#fafaf9';
  const mainWin = await createWindow(winBg);
  // Start background filesystem services after window creation so startup
  // paints immediately without waiting on folder scans or trash purges.
  void watcher.start().catch((e) => logger.error('watcher:start-failed', { error: String(e) }));
  obsidian.start();
  setImmediate(purgeExpiredTrash);
  // Hand off from splash → main as soon as the renderer has painted.
  // ready-to-show fires AFTER the first paint, so the user never sees
  // a blank window. If the renderer fails to load, fall back to a
  // 5 s timeout so the splash doesn't get stuck on screen.
  let handedOff = false;
  const handoff = (): void => {
    if (handedOff) return;
    handedOff = true;
    if (!mainWin.isDestroyed()) mainWin.show();
    splash.close();
  };
  mainWin.once('ready-to-show', handoff);
  setTimeout(handoff, 5000);

  let shuttingDown = false;
  app.on('before-quit', (e) => {
    if (shuttingDown) return;
    shuttingDown = true;
    e.preventDefault();
    pipeline.drain();
    nativeSpeech.close();
    obsidian.stop();
    void (async () => {
      // Stop any active recordings cleanly so finalize is written, instead of
      // leaving the helper to die on parent-watch (which works but leaves an
      // 'orphaned' DB row for an otherwise-clean shutdown).
      try {
        const open = recordingSessionsRepo.findOpen();
        for (const row of open) {
          try { await recordingManager.stop(row.id); } catch { /* best-effort */ }
        }
      } catch (err) {
        logger.error('shutdown:recording-stop-error', { err: String(err) });
      }
      try {
        meetingDetector.stop();
        nativeAppDetector.stop();
        clearInterval(trashPurgeTimer);
        await Promise.all([
          llmSupervisor.stop(),
          watcher.stop(),
        ]);
      } catch (err) {
        logger.error('shutdown:error', { err: String(err) });
      } finally {
        app.dock?.setBadge(''); // belt-and-braces; the recording stops above already clear it
        logger.close();
        app.exit(0);
      }
    })();
  });
  if (smokeRoot) {
    try { await verifyPackageSmoke(smokeRoot, mainWin, app.isPackaged); app.quit(); }
    catch (error) { fs.writeFileSync(path.join(smokeRoot, 'failure.txt'), String(error)); app.exit(1); }
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  // Re-open in the active theme's background so a dark-mode user doesn't get a
  // light flash when re-launching the window from the dock. nativeTheme.themeSource
  // was already set at startup, so shouldUseDarkColors is correct here.
  if (BrowserWindow.getAllWindows().length === 0)
    void createWindow(nativeTheme.shouldUseDarkColors ? '#171615' : '#fafaf9');
});
