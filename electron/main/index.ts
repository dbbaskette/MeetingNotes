import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { openDb } from './storage/db';
import { MeetingsRepo } from './storage/meetings-repo';
import { SpeakersRepo } from './storage/speakers-repo';
import { ActionItemsRepo } from './storage/action-items-repo';
import { SettingsRepo } from './storage/settings-repo';
import { LMStudioClient } from './lm-studio/client';
import { DiarizationClient } from './diarization/client';
import { DiarizationSupervisor } from './diarization/supervisor';
import { AudioHijackBridge } from './audio-hijack/bridge';
import { LibraryWatcher } from './library/watcher';
import { RosterService } from './speakers/roster-service';
import { Pipeline } from './pipeline/pipeline';
import { recoverPendingMeetings } from './pipeline/recovery';
import { runTranscribing } from './pipeline/stages/transcribing';
import { runDiarizing } from './pipeline/stages/diarizing';
import { runMerging } from './pipeline/stages/merging';
import { runIdentifying } from './pipeline/stages/identifying';
import { runSummarizing } from './pipeline/stages/summarizing';
import { runExtracting } from './pipeline/stages/extracting';
import { registerIpcHandlers } from './ipc/handlers';
import { buildExporterRegistry } from './exporters/registry';
import { Logger } from './logging/logger';
import { createMeetingFolder } from './storage/meeting-folder';
import { parseAudioHijackFilename } from './lib/title-from-filename';
import { makeSlug, shortId } from './lib/slug';
import { probeAudio } from './library/ffprobe';

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
  if (isDev) await win.loadURL('http://localhost:5173');
  else await win.loadFile(path.join(__dirname, '../renderer/index.html'));
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
  const diarization = new DiarizationClient('http://127.0.0.1:8765');
  const supervisor = new DiarizationSupervisor({
    sidecarDir: path.join(app.getAppPath(), 'sidecar'),
    onLog: (l) => logger.info('sidecar', { line: l }),
  });
  supervisor.start();

  const audioHijack = new AudioHijackBridge();
  const roster = new RosterService(speakers, libraryRoot);

  const ctx = {
    libraryRoot,
    lmStudio,
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
      const info = await probeAudio(audioPath);
      const parsed = parseAudioHijackFilename(audioPath);
      const id = shortId();
      const dateIso = parsed.startedAtIso?.slice(0, 10) ?? new Date().toISOString().slice(0, 10);
      const slug = makeSlug(dateIso, parsed.autoTitle, id);
      createMeetingFolder(libraryRoot, slug, audioPath);
      meetings.insert({
        id,
        slug,
        title: parsed.autoTitle,
        startedAt: parsed.startedAtIso,
        durationS: info.durationS,
        audioPath,
        status: 'processing',
        pipelineStage: 'discovered',
      });
      logger.info('library:discovered', { id, slug, audioPath });
      pipeline.enqueue(id);
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

  app.on('before-quit', () => {
    supervisor.stop();
    void watcher.stop();
    logger.close();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});
