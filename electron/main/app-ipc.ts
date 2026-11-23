import { app, safeStorage, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { WeeklySummariesRepo } from './storage/weekly-summaries-repo.js';
import { WeeklyAggregator } from './weekly/aggregator.js';
import { createNarrativeGenerator } from './weekly/prompt.js';
import { AskIndex } from './ask/ask-index.js';
import { registerIpcHandlers } from './ipc/handlers.js';
import {LibraryBackup} from './storage/library-backup.js';
import {assertNoLibraryMutations} from './storage/backup-gate.js';
import { buildExporterRegistry } from './exporters/registry.js';
import { GoogleAuth } from './google/auth.js';
import { buildPayloadFromMeeting, type WebhookDeliveryResult } from './exporters/webhook.js';
import { meetingFolderPath } from './storage/meeting-folder.js';
import type { Services } from './services.js';
import type { AppSurfaces } from './app-surfaces.js';

/**
 * Builds Google auth, the exporters (with the webhook auto-fire), the weekly
 * aggregator and the Library backup, then registers the IPC handlers.
 */
export function registerAppIpc(services: Services, surfaces: AppSurfaces, smokeRoot: string | null): void {
  const {
    settingsDb, settings, secrets, db, libraryRoot, meetings, summaryTemplates, groups, speakers, actionItems,
    stageDurations, logger, artifactCache, terminology, notesHistory, obsidian, guardedIpc, lmStudio,
    llmSupervisor, helperPath, recordingManager, appEnumerator, roster, nativeSpeech, pipeline, gateNotified,
    recordingRecovery,
  } = services;
  const { meetingDetector, nativeAppDetector, menuBar, recordShortcut } = surfaces;

  // Google account auth (BYO OAuth desktop client). The refresh token is
  // encrypted via the OS keychain (safeStorage); credentials + email live in
  // settings. Powers the Google Tasks + Google Doc exporters and the
  // Settings "Sign in with Google" flow.
  const googleAuth = new GoogleAuth({
    getCredentials: () => {
      const clientId = settings.get('googleClientId').trim();
      const clientSecret = secrets.read('googleClientSecret').trim();
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
        secret: secrets.read('webhookSecret'),
        template: settings.get('webhookTemplate'),
        ownerFilter: settings.get('webhookOwnerFilter'),
      }),
      setLastResult: (r: WebhookDeliveryResult) => settings.set('webhookLastResult', r),
      appVersion: app.getVersion(),
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
      userDisplayName: speakers.list().find((sp) => sp.id === settings.get('userSpeakerId'))?.displayName ?? null,
    }, {
      url: settings.get('webhookUrl'),
      secret: secrets.read('webhookSecret'),
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
  // report snapshot backed by the weekly_summaries table.
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
      () => settings.get('reasoningEffort'),
    ),
    ensureLLMReady: () => llmSupervisor.ensureReady(),
  });
  const backup=new LibraryBackup({db,settingsDb,root:libraryRoot,version:app.getVersion(),
    assertIdle:()=>{assertNoLibraryMutations();if(recordingManager.active().length||pipeline.getStatus().currentId||obsidian.status().running)throw new Error('Wait for recording, processing, or vault sync to finish before backing up. Nothing was interrupted.');},
    pause:()=>{const paused=pipeline.getStatus().paused;pipeline.pause();return()=>{if(!paused)pipeline.resume();};},
  });
  registerIpcHandlers(guardedIpc, {
    nativeSpeech,
    secrets,
    summaryTemplates,
    ...(smokeRoot ? {} : { menuBar, recordShortcut }),
    backup,
    notesHistory,
    terminology,
    meetings,
    groups,
    speakers,
    actionItems,
    stageDurations,
    settings,
    lmStudio,
    llmSupervisor,
    recordingManager,
    recordingRecovery,
    appEnumerator,
    helperPath,
    roster,
    pipeline,
    exporters,
    libraryRoot,
    meetingDetector,
    nativeAppDetector,
    weeklyAggregator,
    askIndex: new AskIndex(db, libraryRoot),
    logger,
    googleAuth,
    artifactCache,
    gateNotified,
  });
}
