import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDb } from './storage/db.js';
import { MeetingsRepo } from './storage/meetings-repo.js';
import { SpeakersRepo } from './storage/speakers-repo.js';
import { ActionItemsRepo } from './storage/action-items-repo.js';
import { SettingsRepo } from './storage/settings-repo.js';
import { LMStudioClient } from './lm-studio/client.js';
import { DiarizationClient } from './diarization/client.js';
import { DiarizationSupervisor } from './diarization/supervisor.js';
import { RecordingManager } from './recording/manager.js';
import { AppEnumerator } from './recording/app-enumerator.js';
import { resolveHelperPath } from './recording/helper-path.js';
import { recoverOrphans } from './recording/orphan-recovery.js';
import { RecordingSessionsRepo } from './storage/recording-sessions-repo.js';
import { IPC_CHANNELS } from './ipc/contracts.js';
import { LibraryWatcher } from './library/watcher.js';
import { RosterService } from './speakers/roster-service.js';
import { Pipeline } from './pipeline/pipeline.js';
import { recoverPendingMeetings } from './pipeline/recovery.js';
import { runTranscribing } from './pipeline/stages/transcribing.js';
import { runDiarizing } from './pipeline/stages/diarizing.js';
import { runMerging } from './pipeline/stages/merging.js';
import { runIdentifying } from './pipeline/stages/identifying.js';
import { runSummarizing } from './pipeline/stages/summarizing.js';
import { runExtracting } from './pipeline/stages/extracting.js';
import { registerIpcHandlers } from './ipc/handlers.js';
import { MeetingDetector } from './meeting-detector/detector.js';
import { purgeTrashDir, UNDO_WINDOW_MS } from './storage/trash.js';
import { buildExporterRegistry } from './exporters/registry.js';
import { Logger } from './logging/logger.js';
import { createMeetingFolder } from './storage/meeting-folder.js';
import { parseAudioHijackFilename } from './lib/title-from-filename.js';
import { makeSlug, shortId } from './lib/slug.js';
import { probeAudio } from './library/ffprobe.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;

async function createWindow(): Promise<BrowserWindow> {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    // Keep the window from shrinking to a size where the detail view's
    // fixed-width rails + stage timeline chips would clip content off the
    // right edge. 900×600 still leaves the three-column detail layout
    // readable; below that the renderer's responsive breakpoint collapses
    // the rails below the center pane.
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#fafaf9',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  if (isDev) await win.loadURL(process.env.VITE_DEV_URL ?? 'http://localhost:5174');
  else await win.loadFile(path.join(__dirname, '../../renderer/index.html'));
  return win;
}

app.whenReady().then(async () => {
  const settingsDb = openDb(path.join(os.homedir(), 'Documents', 'MeetingNotes', 'db.sqlite'));
  const settings = new SettingsRepo(settingsDb);
  const s = settings.getAll();

  const libraryRoot = s.libraryPath;
  const db = openDb(path.join(libraryRoot, 'db.sqlite'));
  const meetings = new MeetingsRepo(db);
  const speakers = new SpeakersRepo(db);
  const actionItems = new ActionItemsRepo(db);
  const logger = new Logger(path.join(os.homedir(), 'Library', 'Logs', 'MeetingNotes', 'app.log'));

  const lmStudio = new LMStudioClient(s.lmStudioUrl);
  const stt = new LMStudioClient(s.sttUrl);
  const diarization = new DiarizationClient('http://127.0.0.1:8765');
  // In dev, sidecar lives next to source. In a packaged .app, electron-builder
  // copies it to process.resourcesPath/sidecar as an extraResource.
  const sidecarDir = isDev
    ? path.join(app.getAppPath(), 'sidecar')
    : path.join(process.resourcesPath, 'sidecar');
  const supervisor = new DiarizationSupervisor({
    sidecarDir,
    onLog: (l) => logger.info('sidecar', { line: l }),
  });
  void supervisor.start();

  // Built-in audio capture helper. The
  // helper binary is bundled inside MeetingNotes.app; resolve its path so
  // both dev (`npm run dev`) and packaged builds can spawn it.
  const helperPath = resolveHelperPath({
    isPackaged: app.isPackaged,
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
  });
  const recordingsDir = path.join(os.homedir(), 'Music', 'MeetingNotes');
  fs.mkdirSync(recordingsDir, { recursive: true });
  const recordingSessionsRepo = new RecordingSessionsRepo(db);
  const recordingManager = new RecordingManager({
    helperPath,
    recordingsDir,
    repo: recordingSessionsRepo,
  });
  const appEnumerator = new AppEnumerator({ helperPath });

  // Broadcast level + state-change events to all renderer windows. Doing this
  // here (not inside RecordingManager) keeps the manager free of any Electron
  // dependency, which makes it unit-testable with a fake spawn.
  recordingManager.on('level', (sessionId, peakDb) => {
    BrowserWindow.getAllWindows().forEach((w) =>
      w.webContents.send(IPC_CHANNELS.recordingLevelEvent, { sessionId, peakDb }));
  });
  recordingManager.on('state-change', (sessionId, state) => {
    BrowserWindow.getAllWindows().forEach((w) =>
      w.webContents.send(IPC_CHANNELS.recordingStateEvent, { sessionId, state }));
  });

  // One-shot orphan scan at launch: any 'recording' rows whose helper PID is
  // gone get marked 'orphaned' so the UI doesn't think they're still going.
  await recoverOrphans({ repo: recordingSessionsRepo });

  const roster = new RosterService(speakers, libraryRoot);

  const ctx = {
    libraryRoot,
    lmStudio,
    stt,
    diarization,
    meetings,
    speakers,
    actionItems,
    settings,
    roster,
    logger,
  };
  const pipeline = new Pipeline({
    ctx,
    stages: {
      transcribing: runTranscribing,
      diarizing: runDiarizing,
      merging: runMerging,
      identifying: runIdentifying,
      summarizing: runSummarizing,
      extracting: runExtracting,
    },
  });

  // Dual-watch: the new built-in recorder writes .m4a into ~/Music/MeetingNotes,
  // and legacy users still have Audio Hijack writing .mp3 into the configured
  // path. Watching both keeps the Library a single source of truth across the
  // transition and afterwards.
  const watcher = new LibraryWatcher({
    paths: [s.audioWatchPath, recordingsDir, path.join(os.homedir(), 'Music', 'Audio Hijack')],
  });
  watcher.onStableFile(async (audioPath) => {
    try {
      // Dedupe: skip files we've already cataloged. Lets us catalog backlog
      // on first run and quietly no-op on every restart afterward.
      if (meetings.findByAudioPath(audioPath)) return;
      const info = await probeAudio(audioPath);
      const parsed = parseAudioHijackFilename(audioPath);
      const dateIso = parsed.startedAtIso?.slice(0, 10) ?? new Date().toISOString().slice(0, 10);
      // Retry on the (now extremely rare) UNIQUE(slug) collision rather than
      // dropping the recording silently.
      let inserted = false;
      let id = '';
      let slug = '';
      for (let attempt = 0; attempt < 5 && !inserted; attempt++) {
        id = shortId();
        slug = makeSlug(dateIso, parsed.autoTitle, id);
        try {
          createMeetingFolder(libraryRoot, slug, audioPath);
          meetings.insert({
            id, slug,
            title: parsed.autoTitle,
            startedAt: parsed.startedAtIso,
            durationS: info.durationS,
            audioPath,
            // Cataloged only. The user picks which to process from the
            // library — no auto-enqueueing.
            status: 'pending',
            pipelineStage: 'discovered',
          });
          inserted = true;
        } catch (e) {
          if (!String(e).includes('UNIQUE')) throw e;
          logger.info('library:slug-collision-retry', { slug, attempt });
        }
      }
      if (!inserted) throw new Error('slug collision retry exhausted');
      logger.info('library:discovered', { id, slug, audioPath });
    } catch (e) {
      logger.error('library:discover-fail', { audioPath, err: String(e) });
    }
  });
  await watcher.start();

  recoverPendingMeetings({ meetings, enqueue: (id) => pipeline.enqueue(id), logger });

  // Trash purge (UX rec #2 undo-delete). Soft-deleted meetings stay
  // recoverable for UNDO_WINDOW_MS. On launch, purge anything that's
  // already past the window so the user doesn't see day-old trash come
  // back on a restart. Then every 60s check again.
  const purgeExpiredTrash = (): void => {
    const cutoff = new Date(Date.now() - UNDO_WINDOW_MS).toISOString();
    const expired = meetings.findSoftDeleted(cutoff);
    for (const m of expired) {
      purgeTrashDir(libraryRoot, m.id);
      meetings.hardDelete(m.id);
      logger.info('trash:purged', { meetingId: m.id });
    }
  };
  purgeExpiredTrash();
  const trashPurgeTimer = setInterval(purgeExpiredTrash, 60_000);

  // Meeting auto-detect (#12). Opt-in per setting. Polls the frontmost
  // browser tabs for known meeting URLs (Meet/Zoom/Teams/Whereby/etc.) and
  // pushes a meetingDetectedEvent to renderers so they can prompt the user
  // to start recording.
  const meetingDetector = new MeetingDetector({
    isSuppressed: () => recordingSessionsRepo.findOpen().length > 0,
  });
  meetingDetector.onDetected((m) => {
    BrowserWindow.getAllWindows().forEach((w) =>
      w.webContents.send(IPC_CHANNELS.meetingDetectedEvent, m));
  });
  if (s.autoDetectMeetings) meetingDetector.start();

  const exporters = buildExporterRegistry();
  registerIpcHandlers(ipcMain, {
    meetings,
    speakers,
    actionItems,
    settings,
    lmStudio,
    recordingManager,
    appEnumerator,
    helperPath,
    roster,
    pipeline,
    exporters,
    libraryRoot,
    meetingDetector,
  });

  await createWindow();

  let shuttingDown = false;
  app.on('before-quit', (e) => {
    if (shuttingDown) return;
    shuttingDown = true;
    e.preventDefault();
    pipeline.drain();
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
        clearInterval(trashPurgeTimer);
        await Promise.all([supervisor.stop(), watcher.stop()]);
      } catch (err) {
        logger.error('shutdown:error', { err: String(err) });
      } finally {
        logger.close();
        app.exit(0);
      }
    })();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});
