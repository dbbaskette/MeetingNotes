import { app, BrowserWindow, ipcMain, nativeTheme, Notification, safeStorage, shell } from 'electron';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDb } from './storage/db.js';
import { MeetingsRepo } from './storage/meetings-repo.js';
import { SpeakersRepo } from './storage/speakers-repo.js';
import { ActionItemsRepo } from './storage/action-items-repo.js';
import { StageDurationsRepo } from './storage/stage-durations-repo.js';
import { SettingsRepo } from './storage/settings-repo.js';
import { LMStudioClient } from './lm-studio/client.js';
import { DiarizationClient } from './diarization/client.js';
import { createDiarizationSupervisor } from './diarization/supervisor.js';
import { createWhisperSupervisor } from './whisper/supervisor.js';
import { LLMSupervisor } from './llm/supervisor.js';
import { WeeklySummariesRepo } from './storage/weekly-summaries-repo.js';
import { WeeklyAggregator } from './weekly/aggregator.js';
import { createNarrativeGenerator } from './weekly/prompt.js';
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
import { NativeAppDetector } from './meeting-detector/native-app-detector.js';
import { purgeTrashDir, UNDO_WINDOW_MS } from './storage/trash.js';
import { buildExporterRegistry } from './exporters/registry.js';
import { GoogleAuth } from './google/auth.js';
import { buildPayloadFromMeeting, type WebhookDeliveryResult } from './exporters/webhook.js';
import { Logger } from './logging/logger.js';
import { createMeetingFolder, meetingFolderPath } from './storage/meeting-folder.js';
import { parseAudioHijackFilename } from './lib/title-from-filename.js';
import { makeSlug, shortId } from './lib/slug.js';
import { probeAudio } from './library/ffprobe.js';
import { createSplash } from './splash.js';
import { installAppMenu } from './menu.js';
import { SchemeDispatcher } from './url-scheme/dispatcher.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;

// Register meetingnotes:// as our protocol scheme. Doing this before
// app.whenReady() — and before the single-instance lock — so:
//   (a) macOS picks MeetingNotes as the handler from the first launch;
//   (b) `open-url` events that fire during a cold-start (the user did
//       `open meetingnotes://record` while the app wasn't running) are
//       buffered into `pendingSchemeUrls` and replayed once the
//       dispatcher is ready inside whenReady().
// Issue #77.
if (!app.isDefaultProtocolClient('meetingnotes')) {
  app.setAsDefaultProtocolClient('meetingnotes');
}
const pendingSchemeUrls: string[] = [];
let schemeDispatcher: SchemeDispatcher | null = null;
function handleSchemeUrl(url: string): void {
  if (schemeDispatcher) void schemeDispatcher.dispatch(url);
  else pendingSchemeUrls.push(url);
}
// macOS delivers protocol-handler invocations via this Cocoa event. This
// listener is the primary entry point on Mac; the second-instance fallback
// below is a no-op on Mac but keeps the Windows/Linux argv path covered.
app.on('open-url', (event, url) => {
  event.preventDefault();
  handleSchemeUrl(url);
});

async function createWindow(backgroundColor = '#fafaf9'): Promise<BrowserWindow> {
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
    backgroundColor,
    // Don't show until the renderer has painted — paired with the splash
    // window, the user sees the loading card the whole time and then the
    // fully-rendered library, never an empty white frame.
    show: false,
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

  const settingsDb = openDb(path.join(os.homedir(), 'Documents', 'MeetingNotes', 'db.sqlite'));
  const settings = new SettingsRepo(settingsDb);
  const s = settings.getAll();

  const libraryRoot = s.libraryPath;
  const db = openDb(path.join(libraryRoot, 'db.sqlite'));
  const meetings = new MeetingsRepo(db);
  const speakers = new SpeakersRepo(db);
  const actionItems = new ActionItemsRepo(db);
  const stageDurations = new StageDurationsRepo(db);
  const logger = new Logger(path.join(os.homedir(), 'Library', 'Logs', 'MeetingNotes', 'app.log'));

  // Collapse roster entries with matching display names (case + whitespace
  // insensitive) that accumulated before confirmSpeaker started deduping.
  // Idempotent — a no-op once the roster is clean.
  {
    const remap = speakers.dedupeByDisplayName();
    if (remap.size > 0) {
      const currentUser = settings.get('userSpeakerId');
      if (currentUser && remap.has(currentUser)) {
        settings.set('userSpeakerId', remap.get(currentUser)!);
      }
      logger.info('speakers.dedupe', { merged: remap.size });
    }
  }

  // The LLM URL follows the active provider so a `lmStudio.chat()` call
  // hits the right port even after the user switches provider in
  // Settings without restarting the app. 'external' falls back to the
  // user-configured lmStudioUrl.
  const lmStudio = new LMStudioClient(() => {
    const provider = settings.get('summaryProvider');
    if (provider === 'lm-studio') return 'http://127.0.0.1:1234';
    if (provider === 'ollama') return 'http://127.0.0.1:11434';
    return settings.get('lmStudioUrl');
  });
  const stt = new LMStudioClient(s.sttUrl);
  const diarization = new DiarizationClient('http://127.0.0.1:8765');
  // In dev, sidecar lives next to source. In a packaged .app, electron-builder
  // copies it to process.resourcesPath/sidecar as an extraResource.
  const sidecarDir = isDev
    ? path.join(app.getAppPath(), 'sidecar')
    : path.join(process.resourcesPath, 'sidecar');
  // Lazy-spawn supervisors. Neither the pyannote sidecar nor
  // whisper-server starts at app launch — the first pipeline stage
  // that needs them calls `await ensureReady()`. Both shut down
  // automatically after 10 minutes of inactivity to free RAM
  // (~500 MB pyannote, ~1.5–3 GB whisper depending on model).
  const diarSupervisor = createDiarizationSupervisor({
    sidecarDir,
    onLog: (l) => logger.info('sidecar', { line: l }),
  });
  const whisperSupervisor = createWhisperSupervisor({
    getModelId: () => settings.get('sttModel'),
    onLog: (l) => logger.info('whisper', { line: l }),
  });
  // Phase 3 LLM-provider lifecycle. When summaryProvider='external'
  // (the default), this is a no-op and behavior matches today's
  // user-managed LM Studio / Ollama. Switching to 'lm-studio' or
  // 'ollama' in Settings makes the supervisor spawn `lms server start`
  // / `ollama serve` on demand and idle-shutdown after 10 min.
  const llmSupervisor = new LLMSupervisor({
    getProvider: () => settings.get('summaryProvider'),
    getModelId: () => settings.get('llmModel'),
    onLog: (l) => logger.info('llm', { line: l }),
  });

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

  // One-shot backfill: rows from earlier app versions can have started_at
  // NULL because the built-in recorder filename format
  // (recording-YYYYMMDD-HHMMSS-...) wasn't recognized at the time. Parse
  // the timestamp out now so the Weekly view can group those meetings into
  // the correct ISO week. Idempotent — only updates rows where
  // started_at IS NULL and the filename actually parses.
  {
    const missing = meetings.findMissingStartedAt();
    let filled = 0;
    for (const m of missing) {
      const parsed = parseAudioHijackFilename(m.audioPath);
      if (!parsed.startedAtIso) continue;
      meetings.setStartedAt(m.id, parsed.startedAtIso);
      filled += 1;
    }
    if (filled > 0) logger.info('startup:backfilled-started-at', { filled });
  }

  const roster = new RosterService(speakers, libraryRoot);

  const ctx = {
    libraryRoot,
    lmStudio,
    stt,
    diarization,
    diarSupervisor,
    whisperSupervisor,
    llmSupervisor,
    meetings,
    speakers,
    actionItems,
    settings,
    stageDurations,
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
      // Tell every open renderer window that a new meeting row exists.
      // Without this, the Library view stays stale after a Stop because
      // its post-stop refresh fires before chokidar's stability debounce
      // — and with no live recording or pending meetings yet in state,
      // the conditional 3s poll never starts.
      for (const w of BrowserWindow.getAllWindows()) {
        w.webContents.send(IPC_CHANNELS.meetingsAddedEvent, { id });
      }
    } catch (e) {
      logger.error('library:discover-fail', { audioPath, err: String(e) });
    }
  });
  await watcher.start();

  recoverPendingMeetings({ meetings, enqueue: (id) => pipeline.enqueue(id), logger });

  // Broadcast queue state changes to all renderer windows so the
  // pause/resume/clear UI in the LibraryView reflects what's
  // happening without a polling timer.
  pipeline.onStatusChange((status) => {
    for (const w of BrowserWindow.getAllWindows()) {
      w.webContents.send(IPC_CHANNELS.pipelineStatusEvent, status);
    }
  });

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

  // Meeting auto-detect (#12 browser tabs, #78 native apps). Two detectors,
  // each opt-in via its own toggle inside the autoDetectMeetings setting
  // object. Both broadcast on the same renderer event channel so the
  // banner can switch on `source` to pick its copy.
  const meetingDetector = new MeetingDetector({
    isSuppressed: () => recordingSessionsRepo.findOpen().length > 0,
  });
  meetingDetector.onDetected((m) => {
    BrowserWindow.getAllWindows().forEach((w) =>
      w.webContents.send(IPC_CHANNELS.meetingDetectedEvent, { source: 'browser-tab', ...m }));
  });
  const nativeAppDetector = new NativeAppDetector({
    appEnumerator,
    silenceMs: s.autoDetectMeetings.silenceMs,
    isSuppressed: () => recordingSessionsRepo.findOpen().length > 0,
    log: (msg, data) => logger.info(msg, data),
  });
  nativeAppDetector.onDetected((m) => {
    // Zoom auto-record path (#78 follow-up). When the user has opted into
    // "always record Zoom", skip the banner and start a recording right
    // away. Any other meeting app still surfaces the confirm-first banner.
    // Existing recordings, dismissals, and the silenceMs debounce are
    // already handled inside the detector — by the time we get here the
    // detector has decided this is a fresh, undismissed call worth
    // surfacing.
    if (m.bundleId === 'us.zoom.xos' && settings.get('autoRecordZoom')) {
      void (async () => {
        try {
          const { sessionId } = await recordingManager.start({
            targetPid: m.pid,
            targetLabel: m.appName,
            mic: true,
          });
          const startedAt = new Date().toISOString();
          logger.info('native-detector:auto-record-started', {
            bundleId: m.bundleId, sessionId, label: m.appName,
          });
          for (const w of BrowserWindow.getAllWindows()) {
            w.webContents.send('mn:auto-recording-started', {
              sessionId, label: m.appName, startedAt,
            });
          }
        } catch (err) {
          // If auto-record fails (helper not running, mic perm denied),
          // fall back to the banner so the user has a clear path forward
          // instead of a silent failure.
          logger.error('native-detector:auto-record-failed', {
            bundleId: m.bundleId, err: String(err),
          });
          for (const w of BrowserWindow.getAllWindows()) {
            w.webContents.send(IPC_CHANNELS.meetingDetectedEvent, m);
          }
        }
      })();
      return;
    }
    BrowserWindow.getAllWindows().forEach((w) =>
      w.webContents.send(IPC_CHANNELS.meetingDetectedEvent, m));
  });
  if (s.autoDetectMeetings.browserTabs) meetingDetector.start();
  if (s.autoDetectMeetings.nativeApps) nativeAppDetector.start();

  // meetingnotes:// URL scheme dispatcher (#77). Wires the protocol-handler
  // verbs (record / stop / open) into the existing recording + window
  // surfaces. Pending URLs that arrived before whenReady completes are
  // flushed here.
  schemeDispatcher = new SchemeDispatcher({
    recordingManager,
    appEnumerator,
    recordingSessionsRepo,
    meetings,
    emitOpenMeeting: (meetingId) => {
      for (const w of BrowserWindow.getAllWindows()) {
        w.webContents.send('mn:open-meeting', meetingId);
      }
    },
    notify: ({ title, body }) => {
      try {
        if (Notification.isSupported()) new Notification({ title, body }).show();
      } catch (err) {
        logger.error('url-scheme:notify-failed', { err: String(err) });
      }
    },
    focusMainWindow: () => {
      const wins = BrowserWindow.getAllWindows();
      if (wins.length === 0) return;
      const target = wins[0]!;
      if (target.isMinimized()) target.restore();
      target.show();
      target.focus();
    },
    logger,
  });
  for (const url of pendingSchemeUrls.splice(0)) {
    void schemeDispatcher.dispatch(url);
  }

  // Google account auth (BYO OAuth desktop client). The refresh token is
  // encrypted via the OS keychain (safeStorage); credentials + email live in
  // settings. Powers the Google Tasks + Google Doc exporters and the
  // Settings "Sign in with Google" flow.
  const googleAuth = new GoogleAuth({
    getCredentials: () => {
      const clientId = settings.get('googleClientId').trim();
      const clientSecret = settings.get('googleClientSecret').trim();
      return clientId && clientSecret ? { clientId, clientSecret } : null;
    },
    getRefreshToken: () => {
      const enc = settings.get('googleRefreshTokenEnc');
      if (!enc || !safeStorage.isEncryptionAvailable()) return null;
      try { return safeStorage.decryptString(Buffer.from(enc, 'base64')); } catch { return null; }
    },
    setRefreshToken: (token) => {
      if (token == null) { settings.set('googleRefreshTokenEnc', null); return; }
      if (!safeStorage.isEncryptionAvailable()) {
        logger.warn('google:safeStorage-unavailable — refusing to store refresh token in plaintext');
        settings.set('googleRefreshTokenEnc', null);
        return;
      }
      settings.set('googleRefreshTokenEnc', safeStorage.encryptString(token).toString('base64'));
    },
    getAccountEmail: () => settings.get('googleAccountEmail'),
    setAccountEmail: (email) => settings.set('googleAccountEmail', email),
    openExternal: (url) => shell.openExternal(url),
    fetchImpl: globalThis.fetch,
    log: (msg, data) => logger.info(msg, data),
  });

  // Webhook exporter (#79). Implements the standard Exporter interface so
  // the manual export path keeps working, and exposes an extra
  // deliverPayload() entry point for the pipeline's auto-fire below.
  const exporters = buildExporterRegistry({
    google: googleAuth,
    fetchImpl: globalThis.fetch,
    webhook: {
      getConfig: () => ({
        url: settings.get('webhookUrl'),
        secret: settings.get('webhookSecret'),
        template: settings.get('webhookTemplate'),
        ownerFilter: settings.get('webhookOwnerFilter'),
      }),
      setLastResult: (r: WebhookDeliveryResult) => settings.set('webhookLastResult', r),
      fetchImpl: globalThis.fetch,
      log: (msg, data) => logger.info(msg, data),
    },
  });
  // Auto-fire: when a meeting reaches status='done', POST the payload
  // to the configured endpoint. Settings gate controls whether anything
  // actually happens; URL validation happens inside deliverPayload so
  // a misconfigured endpoint surfaces in the Settings card without
  // blocking the meeting's completion.
  pipeline.onMeetingComplete(async (meetingId) => {
    if (!settings.get('exporterWebhook')) return;
    const webhook = exporters.webhook;
    if (!webhook || typeof (webhook as { deliverPayload?: unknown }).deliverPayload !== 'function') return;
    const meeting = meetings.findById(meetingId);
    if (!meeting) return;
    const folder = meetingFolderPath(libraryRoot, meeting.slug);
    const summaryPath = path.join(folder, 'summary.md');
    const transcriptPath = path.join(folder, 'transcript.md');
    const summaryMd = fs.existsSync(summaryPath) ? fs.readFileSync(summaryPath, 'utf8') : null;
    const transcriptMd = fs.existsSync(transcriptPath) ? fs.readFileSync(transcriptPath, 'utf8') : null;
    const items = actionItems.listByMeeting(meetingId);
    const attendees = speakers.listForMeeting(meetingId)
      .map((sp) => sp.displayName ?? sp.localLabel);
    const payload = buildPayloadFromMeeting({
      meetingId: meeting.id,
      slug: meeting.slug,
      title: meeting.title,
      startedAt: meeting.startedAt,
      durationS: meeting.durationS,
      audioPath: meeting.audioPath,
      meetingFolder: folder,
      summaryMd,
      transcriptMd,
      attendees,
      actionItems: items.map((ai) => ({
        text: ai.text,
        ownerName: ai.ownerName,
        ownerSpeakerId: ai.ownerSpeakerId,
        dueDate: ai.dueDate,
        status: ai.status,
      })),
      userSpeakerId: settings.get('userSpeakerId'),
    }, {
      url: settings.get('webhookUrl'),
      secret: settings.get('webhookSecret'),
      template: settings.get('webhookTemplate'),
      ownerFilter: settings.get('webhookOwnerFilter'),
    });
    const result = await (webhook as unknown as { deliverPayload: (p: typeof payload) => Promise<WebhookDeliveryResult> }).deliverPayload(payload);
    if (result.error) {
      logger.error('webhook:auto-fire-failed', { meetingId, error: result.error });
    }
  });
  // Weekly summary aggregator (#weekly). Builds the per-week digest
  // from the existing meetings + action_items tables, with an LLM-
  // narrative cache backed by the weekly_summaries table.
  const weeklySummaries = new WeeklySummariesRepo(db);
  const weeklyAggregator = new WeeklyAggregator({
    meetings,
    actionItems,
    speakers,
    settings,
    weeklySummaries,
    libraryRoot,
    generateNarrative: createNarrativeGenerator(
      lmStudio,
      () => settings.get('llmModel'),
      () => settings.get('disableThinking'),
    ),
    ensureLLMReady: () => llmSupervisor.ensureReady(),
  });
  registerIpcHandlers(ipcMain, {
    meetings,
    speakers,
    actionItems,
    settings,
    lmStudio,
    llmSupervisor,
    recordingManager,
    appEnumerator,
    helperPath,
    roster,
    pipeline,
    exporters,
    libraryRoot,
    meetingDetector,
    nativeAppDetector,
    weeklyAggregator,
    logger,
    googleAuth,
  });

  const themeChoice = settings.get('theme');
  nativeTheme.themeSource = themeChoice;
  const winBg = nativeTheme.shouldUseDarkColors ? '#171615' : '#fafaf9';
  const mainWin = await createWindow(winBg);
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
          diarSupervisor.stop(),
          whisperSupervisor.stop(),
          llmSupervisor.stop(),
          watcher.stop(),
        ]);
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
  // Re-open in the active theme's background so a dark-mode user doesn't get a
  // light flash when re-launching the window from the dock. nativeTheme.themeSource
  // was already set at startup, so shouldUseDarkColors is correct here.
  if (BrowserWindow.getAllWindows().length === 0)
    void createWindow(nativeTheme.shouldUseDarkColors ? '#171615' : '#fafaf9');
});
