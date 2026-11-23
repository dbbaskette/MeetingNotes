import { app, BrowserWindow, ipcMain, protocol, safeStorage, screen, shell } from 'electron';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { validateIpc } from './ipc/channel-schemas.js';
import { SecretSettings } from './storage/secret-settings.js';
import { SummaryTemplateStore } from './storage/summary-template-store.js';
import { NativeSpeechService, nativeModelFolder } from './speech/service.js';
import { recoveryMediaHandler } from './recording/recovery-media.js';
import { openDb } from './storage/db.js';
import { MeetingsRepo } from './storage/meetings-repo.js';
import { GroupsRepo } from './storage/groups-repo.js';
import { ObsidianSync } from './obsidian/service.js';
import { registerObsidianHandlers } from './ipc/obsidian-handlers.js';
import { TerminologyRepo } from './storage/terminology-repo.js';
import { TerminologyService } from './terminology/service.js';
import { NotesHistory } from './storage/notes-history.js';
import { SpeakersRepo } from './storage/speakers-repo.js';
import { ActionItemsRepo } from './storage/action-items-repo.js';
import { StageDurationsRepo } from './storage/stage-durations-repo.js';
import { SettingsRepo } from './storage/settings-repo.js';
import { LMStudioClient } from './lm-studio/client.js';
import { LLMSupervisor } from './llm/supervisor.js';
import { RecordingManager } from './recording/manager.js';
import { AutoProcessRecordings } from './recording/auto-process.js';
import { probeAudio } from './library/ffprobe.js';
import { AppEnumerator } from './recording/app-enumerator.js';
import { resolveHelperPath } from './recording/helper-path.js';
import { recoverOrphans } from './recording/orphan-recovery.js';
import { RecordingSessionsRepo } from './storage/recording-sessions-repo.js';
import { IPC_CHANNELS } from './ipc/contracts.js';
import { LibraryWatcher } from './library/watcher.js';
import { catalogAudio } from './library/catalog.js';
import { DiscoverFailureGate, fileState } from './library/discover-failure-gate.js';
import { InvalidAudioError } from './library/ffprobe.js';
import { RecordingRecoveryService, revealPathInFinder } from './recording/recovery.js';
import { recordingsDirFor, libraryWatchPaths } from './lib/storage-paths.js';
import { RosterService } from './speakers/roster-service.js';
import { VoiceProfiles } from './speakers/voice-profiles.js';
import { Pipeline } from './pipeline/pipeline.js';
import { recoverPendingMeetings } from './pipeline/recovery.js';
import { runTranscribing } from './pipeline/stages/transcribing.js';
import { runDiarizing } from './pipeline/stages/diarizing.js';
import { runMerging } from './pipeline/stages/merging.js';
import { runIdentifying } from './pipeline/stages/identifying.js';
import { runSummarizing } from './pipeline/stages/summarizing.js';
import { runExtracting } from './pipeline/stages/extracting.js';
import {guardLibraryIpc} from './ipc/backup-guard.js';
import {backupIsLocked} from './storage/backup-gate.js';
import { purgeTrashDir, TRASH_RETENTION_MS } from './storage/trash.js';
import { Logger } from './logging/logger.js';
import { parseAudioHijackFilename } from './lib/title-from-filename.js';
import { createPeakThrottle } from './lib/peak-throttle.js';
import { boundsVisibleOn, sanitizeBounds } from './lib/window-bounds.js';
import { ArtifactCache } from './library/artifact-cache.js';
import { seedPackageSmoke } from './lib/package-smoke.js';
import { setWindowBoundsStore, setWindowLog } from './app-window.js';

/**
 * Opens the databases and builds the repositories and core services the main
 * process runs on: settings, repos, logger, LLM client/supervisor, recorder,
 * pipeline, library watcher and recovery. Called from whenReady() after the
 * splash and app menu; every side effect runs in the order it always has.
 */
export async function createServices(smokeRoot: string | null) {
  const settingsDbPath = path.join(smokeRoot ?? path.join(os.homedir(), 'Documents', 'MeetingNotes'), 'db.sqlite');
  const settingsDb = openDb(settingsDbPath);
  const settings = new SettingsRepo(settingsDb);
  // Secrets are encrypted with the keychain and never sent to the renderer.
  // Values saved as plaintext by earlier versions are converted here (#249).
  const secrets = new SecretSettings(settings, safeStorage);
  const migratedSecrets = secrets.migrate();
  if (smokeRoot) seedPackageSmoke(smokeRoot, settings);
  const s = settings.getAll();

  // Restore the window where the user left it — but only if that position
  // is still on an attached display (a laptop that left its desk monitor
  // behind would otherwise open the window into the void).
  setWindowBoundsStore({
    load: () => {
      const saved = sanitizeBounds(settings.get('windowBounds'));
      if (!saved) return null;
      return boundsVisibleOn(screen.getAllDisplays(), saved) ? saved : null;
    },
    save: (b) => settings.set('windowBounds', b),
  });

  const libraryRoot = s.libraryPath;
  const libraryDbPath = path.join(libraryRoot, 'db.sqlite');
  const db = path.resolve(libraryDbPath) === path.resolve(settingsDbPath)
    ? settingsDb
    : openDb(libraryDbPath);
  const meetings = new MeetingsRepo(db);
  const summaryTemplates = new SummaryTemplateStore(db);
  if (smokeRoot) seedPackageSmoke(smokeRoot, settings, meetings);
  const groups = new GroupsRepo(db);
  const speakers = new SpeakersRepo(db);
  const actionItems = new ActionItemsRepo(db);
  const stageDurations = new StageDurationsRepo(db);
  const logger = new Logger(path.join(smokeRoot ?? path.join(os.homedir(), 'Library', 'Logs', 'MeetingNotes'), 'app.log'));
  setWindowLog((msg, data) => logger.warn(msg, data));
  if (migratedSecrets.length) logger.info('settings:secrets-encrypted', { keys: migratedSecrets });
  const artifactCache = new ArtifactCache();
  const terminology = new TerminologyService(new TerminologyRepo(db), {
    libraryRoot, meetings, speakers, artifactCache, userName: () => settings.get('userName'),
    beforeSummaryChange: id => notesHistory.capture(id, 'Before notes changed'),
  });
  const notesHistory = new NotesHistory(db, {libraryRoot, meetings, items: actionItems, terminology});
  terminology.recover();
  try { notesHistory.recover(); } catch (e) { logger.error('notes-history:recovery', {error: String(e)}); }
  const obsidian = new ObsidianSync(db, { libraryRoot, meetings, speakers, items: actionItems, settings, stale: id => terminology.stale(id) });
  // Every handler validates its arguments (channel-schemas.ts), then writes are
  // held back while a Library backup is copying.
  const guardedIpc=validateIpc(guardLibraryIpc(ipcMain));
  registerObsidianHandlers(guardedIpc, obsidian);

  // Collapse roster entries with matching display names (case + whitespace
  // insensitive) that accumulated before confirmSpeaker started deduping.
  // Idempotent — a no-op once the roster is clean.
  try {
    const remap = speakers.dedupeByDisplayName((source, target) => new VoiceProfiles(libraryRoot).merge(source, target));
    if (remap.size > 0) {
      const currentUser = settings.get('userSpeakerId');
      if (currentUser && remap.has(currentUser)) {
        settings.set('userSpeakerId', remap.get(currentUser)!);
      }
      logger.info('speakers.dedupe', { merged: remap.size });
    }
  } catch (error) {
    logger.warn('speakers.dedupe-skipped', { reason: String(error) });
  }

  // The LLM URL follows the active provider so a `lmStudio.chat()` call
  // hits the right port even after the user switches provider in
  // Settings without restarting the app. 'external' falls back to the
  // user-configured lmStudioUrl.
  const lmStudio = new LMStudioClient(
    () => {
      const provider = settings.get('summaryProvider');
      if (provider === 'lm-studio') return 'http://127.0.0.1:1234';
      if (provider === 'ollama') return 'http://127.0.0.1:11434';
      return settings.get('lmStudioUrl');
    },
    () => {
      const provider = settings.get('summaryProvider');
      if (provider === 'lm-studio') return 'LM Studio';
      if (provider === 'ollama') return 'Ollama';
      return 'LLM server';
    },
  );
  // Phase 3 LLM-provider lifecycle. When summaryProvider='external'
  // (the default), this is a no-op and behavior matches today's
  // user-managed LM Studio / Ollama. Switching to 'lm-studio' or
  // 'ollama' in Settings makes the supervisor spawn `lms server start`
  // / `ollama serve` on demand and idle-shutdown after 10 min.
  const llmSupervisor = new LLMSupervisor({
    getProvider: () => settings.get('summaryProvider'),
    getModelId: () => settings.get('llmModel'),
    getContextLength: () => settings.get('llmContextLength'),
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
  // Recordings live inside the library root now (Option B). Derived from
  // libraryPath, so relocating the library moves recordings with it — no
  // separate setting.
  const recordingsDir = recordingsDirFor(libraryRoot);
  fs.mkdirSync(recordingsDir, { recursive: true });
  const recordingSessionsRepo = new RecordingSessionsRepo(db);
  const recordingManager = new RecordingManager({
    helperPath,
    recordingsDir,
    repo: recordingSessionsRepo,
    onFinalized: (id, audioPath) => {
      activeRecordings.delete(id);
      app.dock?.setBadge(activeRecordings.size > 0 ? 'REC' : '');
      void completedCapture.finalized(id, audioPath);
    },
    // Read on every use, so a Settings change reaches a recording in progress.
    getSilencePolicy: () => ({
      autoStopOnSilence: settings.get('autoStopOnSilence'),
      promptAfterMs: settings.get('silencePromptAfterS') * 1000,
      countdownMs: settings.get('silenceCountdownS') * 1000,
    }),
    onAutoStop: (sessionId, silentForMs) =>
      logger.info('recording:auto-stop-silence', { sessionId, silentForMs }),
    onDiagnostic: (sessionId, diagnostic) => {
      const { stage } = diagnostic;
      if (stage === 'tap_stalled') logger.warn('recording:app-audio-stalled', { sessionId, ...diagnostic });
      else if (stage === 'tap_recovered') logger.info('recording:app-audio-recovered', { sessionId, ...diagnostic });
      else if (stage === 'pcmbuf_nil' || stage === 'conv_err') logger.warn('recording:app-audio-conversion-failed', { sessionId, ...diagnostic });
      else if (stage === 'mic_format' || stage === 'capture_timing' || stage === 'capture_timing_stop') logger.info('recording:capture-timing', { sessionId, ...diagnostic });
      // Tap format, device running state, callback counts, buffer shapes.
      else logger.info('recording:app-audio-tap', { sessionId, ...diagnostic });
    },
  });
  const appEnumerator = new AppEnumerator({ helperPath });

  // Broadcast level + state-change events to all renderer windows. Doing this
  // here (not inside RecordingManager) keeps the manager free of any Electron
  // dependency, which makes it unit-testable with a fake spawn.
  // The helper prints a level line per audio buffer (30–60/sec) — far more
  // than a VU meter needs. Coalesce to 10Hz per session with peak-hold so
  // the meter still catches transients but each window's webContents.send
  // rate drops ~5x. The manager keeps emitting per-line (Electron-free,
  // unit-testable); the throttle lives at the IPC boundary.
  const levelThrottle = createPeakThrottle(100, (key, peakDb) => {
    const [sessionId, source] = key.split(':') as [string, 'mic' | 'system' | 'mixed'];
    BrowserWindow.getAllWindows().forEach((w) =>
      w.webContents.send(IPC_CHANNELS.recordingLevelEvent, { sessionId, source, peakDb }));
  });
  recordingManager.on('level', (sessionId, source, peakDb) => {
    levelThrottle.push(`${sessionId}:${source}`, peakDb);
  });
  // Dock badge while recording: "REC" whenever at least one session is
  // actively capturing ('starting' counts — the helper is already attached
  // by then), cleared when the last one ends. app.dock is macOS-only, so
  // guard it for the (hypothetical) non-Mac build.
  const activeRecordings = new Set<string>();
  recordingManager.on('state-change', (sessionId, state, reason) => {
    BrowserWindow.getAllWindows().forEach((w) =>
      w.webContents.send(IPC_CHANNELS.recordingStateEvent, { sessionId, state, reason }));
    if (state === 'starting' || state === 'recording' || state === 'stopping') activeRecordings.add(sessionId);
    else {
      activeRecordings.delete(sessionId);
      levelThrottle.clearPrefix(`${sessionId}:`);
    }
    app.dock?.setBadge(activeRecordings.size > 0 ? 'REC' : '');
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
  const nativeSpeech = new NativeSpeechService(app.isPackaged
    ? path.join(process.resourcesPath, 'bin', 'meeting-notes-speech')
    : path.join(app.getAppPath(), 'speech-engine', '.build', 'release', 'meeting-notes-speech'), nativeModelFolder());

  const ctx = {
    nativeSpeech,
    summaryTemplateFor: (meetingId: string) => summaryTemplates.effectiveFor(meetingId),
    notesHistory,
    terminology,
    libraryRoot,
    artifactCache,
    lmStudio,
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

  // Meetings we've already alerted about entering the speaker-ID gate, so we
  // notify once per entry (spec: no nagging). Cleared when a meeting is
  // unblocked — see the IPC handlers.
  const gateNotified = new Set<string>();

  // Multi-watch (Option B): the built-in recorder now writes .m4a into
  // <library>/recordings, so that's watched first. We also always watch the
  // legacy ~/Music/MeetingNotes (old recorder location) and ~/Music/Audio Hijack
  // (Audio Hijack drops) so files that land there during/after the transition
  // are still cataloged. The optional user-configured audioWatchPath is appended
  // last (deduped). Watching all keeps the Library a single source of truth.
  const watcher = new LibraryWatcher({
    paths: smokeRoot ? [recordingsDir] : libraryWatchPaths({ libraryRoot, audioWatchPath: s.audioWatchPath, home: os.homedir() }),
  });
  const notifyMeetingAdded = (id: string): void => {
    for (const w of BrowserWindow.getAllWindows()) {
      w.webContents.send(IPC_CHANNELS.meetingsAddedEvent, { id });
    }
  };
  const catalogRecording = async (audioPath: string) => {
    const result = await catalogAudio(audioPath, {
      meetings,
      sessions: recordingSessionsRepo,
      libraryRoot,
      onSlugCollision: (slug, attempt) =>
        logger.info('library:slug-collision-retry', { slug, attempt }),
    });
    if (result.kind === 'added') {
      logger.info('library:discovered', { id: result.meeting.id, audioPath });
      notifyMeetingAdded(result.meeting.id);
    }
    return result;
  };
  const discoverGate = new DiscoverFailureGate(3);
  const completedCapture = new AutoProcessRecordings({
    enabled: () => settings.get('autoProcessRecordings'),
    catalog: catalogRecording,
    verify: probeAudio,
    queued: (id) => { meetings.updateStatus(id, 'processing'); notifyMeetingAdded(id); },
    enqueue: (id) => pipeline.enqueue(id),
    failed: (sessionId, error) => logger.warn('recording:completion-catalog-failed', { sessionId, error: String(error), note: 'Audio retained for recovery; not auto-processed.' }),
  });
  watcher.onStableFile(async (audioPath) => {
    const onDisk = fileState(audioPath);
    if (onDisk && discoverGate.shouldSkip(audioPath, onDisk)) {
      watcher.release(audioPath);
      return;
    }
    try {
      await catalogRecording(audioPath);
      discoverGate.clear(audioPath);
    } catch (e) {
      // The built-in helper may stop appending samples before it finalizes the
      // M4A's moov atom. Let the finalization change event retry this path.
      watcher.release(audioPath);
      if (e instanceof InvalidAudioError && onDisk && discoverGate.recordFailure(audioPath, onDisk) === 'quarantined') {
        logger.warn('library:discover-quarantined', { audioPath, err: String(e), note: 'Invalid media; retry after file changes or app restart. The file has not been moved or deleted.' });
      } else {
        if (onDisk && !(e instanceof InvalidAudioError)) discoverGate.recordTransientFailure(audioPath, onDisk);
        logger.error('library:discover-fail', { audioPath, err: String(e) });
      }
    }
  });

  const recordingRecovery = new RecordingRecoveryService({
    sessions: recordingSessionsRepo,
    meetings,
    catalog: catalogRecording,
    reveal: (audioPath) => revealPathInFinder(audioPath, shell),
    trash: (file) => shell.trashItem(file),
  });
  protocol.handle('recovery-audio', recoveryMediaHandler(recordingRecovery));

  recoverPendingMeetings({ meetings, enqueue: (id) => pipeline.enqueue(id), logger });

  // Broadcast queue state changes to all renderer windows so the
  // pause/resume/clear UI in the LibraryView reflects what's
  // happening without a polling timer.
  pipeline.onStatusChange((status) => {
    for (const w of BrowserWindow.getAllWindows()) {
      w.webContents.send(IPC_CHANNELS.pipelineStatusEvent, status);
    }
  });
  pipeline.onMeetingStageChange((meetingId) => {
    for (const w of BrowserWindow.getAllWindows()) {
      w.webContents.send(IPC_CHANNELS.meetingStageEvent, meetingId);
    }
  });

  // Trash purge (UX rec #2 undo-delete + Recently deleted view).
  // Soft-deleted meetings stay recoverable for TRASH_RETENTION_MS (30
  // days). On launch, purge anything already past the window; then check
  // hourly — with a 30-day window, second-level precision buys nothing.
  // The trash:list IPC also purges before answering, so the "Recently
  // deleted" section never offers a restore that can't succeed.
  const purgeExpiredTrash = (): void => {
    if(backupIsLocked())return;
    const cutoff = new Date(Date.now() - TRASH_RETENTION_MS).toISOString();
    const expired = meetings.findSoftDeleted(cutoff);
    for (const m of expired) {
      purgeTrashDir(libraryRoot, m.id);
      meetings.hardDelete(m.id);
      logger.info('trash:purged', { meetingId: m.id });
    }
  };
  const trashPurgeTimer = setInterval(purgeExpiredTrash, 60 * 60_000);

  return {
    s, settingsDb, settings, secrets, db, libraryRoot, meetings, summaryTemplates, groups, speakers,
    actionItems, stageDurations, logger, artifactCache, terminology, notesHistory, obsidian, guardedIpc,
    lmStudio, llmSupervisor, helperPath, recordingSessionsRepo, recordingManager, appEnumerator, roster,
    nativeSpeech, pipeline, gateNotified, watcher, recordingRecovery, purgeExpiredTrash, trashPurgeTimer,
  };
}

export type Services = Awaited<ReturnType<typeof createServices>>;
