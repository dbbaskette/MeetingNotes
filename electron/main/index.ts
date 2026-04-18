import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { openDb } from './storage/db.js';
import { MeetingsRepo } from './storage/meetings-repo.js';
import { SpeakersRepo } from './storage/speakers-repo.js';
import { ActionItemsRepo } from './storage/action-items-repo.js';
import { SettingsRepo } from './storage/settings-repo.js';
import { LMStudioClient } from './lm-studio/client.js';
import { DiarizationClient } from './diarization/client.js';
import { DiarizationSupervisor } from './diarization/supervisor.js';
import { AudioHijackBridge } from './audio-hijack/bridge.js';
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

  const audioHijack = new AudioHijackBridge();
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

  const watcher = new LibraryWatcher({ path: s.audioWatchPath });
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

  const exporters = buildExporterRegistry();
  registerIpcHandlers(ipcMain, {
    meetings,
    speakers,
    actionItems,
    settings,
    lmStudio,
    audioHijack,
    roster,
    pipeline,
    exporters,
    libraryRoot,
  });

  await createWindow();

  let shuttingDown = false;
  app.on('before-quit', (e) => {
    if (shuttingDown) return;
    shuttingDown = true;
    e.preventDefault();
    pipeline.drain();
    void (async () => {
      try {
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
