import type { IpcMain } from 'electron';
import { app, dialog, shell } from 'electron';
import fs from 'node:fs';
import { z } from 'zod';
import { IPC_CHANNELS } from './contracts.js';
import type { MeetingsRepo } from '../storage/meetings-repo.js';
import type { GroupsRepo } from '../storage/groups-repo.js';
import type { SpeakersRepo } from '../storage/speakers-repo.js';
import type { ActionItemsRepo } from '../storage/action-items-repo.js';
import type { SettingsRepo } from '../storage/settings-repo.js';
import { LMStudioError, REASONING_LOOP_MARKER, type LMStudioClient } from '../lm-studio/client.js';
import { ACTION_ITEM_SYSTEM_PROMPT } from '../pipeline/prompts.js';
import { probeError } from './probe-error.js';
import type { RecordingManager } from '../recording/manager.js';
import type { RecordingRecoveryService } from '../recording/recovery.js';
import type { AppEnumerator } from '../recording/app-enumerator.js';
import type { MeetingDetector } from '../meeting-detector/detector.js';
import type { NativeAppDetector } from '../meeting-detector/native-app-detector.js';
import type { RosterService } from '../speakers/roster-service.js';
import type { Pipeline } from '../pipeline/pipeline.js';
import type { Exporter } from '../exporters/interface.js';
import type { StageDurationsRepo } from '../storage/stage-durations-repo.js';
import type { WeeklyAggregator } from '../weekly/aggregator.js';
import { registerWeeklyHandlers } from './weekly-handlers.js';
import { registerAskHandlers } from './ask-handlers.js';
import type { AskIndex } from '../ask/ask-index.js';
import { detectProviders, type ProviderAvailability } from '../llm/supervisor.js';
import { registerSettingsHandlers } from './settings-handlers.js';
import { registerExportHandlers } from './export-handlers.js';
import type { Logger } from '../logging/logger.js';
import type { SecretSettings } from '../storage/secret-settings.js';
import type { SummaryTemplateStore } from '../storage/summary-template-store.js';
import { SUMMARY_TEMPLATES } from '../../shared/summary-templates.js';
import { createReportLimiter, normalizeRendererError } from '../logging/renderer-error.js';
import type { GoogleAuth } from '../google/auth.js';
import { tailLogFile } from '../logging/log-tail.js';
import type { ArtifactCache } from '../library/artifact-cache.js';
import type { TerminologyService } from '../terminology/service.js';
import { registerTerminologyHandlers } from './terminology-handlers.js';
import type { NotesHistory } from '../storage/notes-history.js';
import type {LibraryBackup} from '../storage/library-backup.js';
import type { NativeSpeechService } from '../speech/service.js';
import { registerSearchCancelHandler, registerSearchQueryHandler } from './search-handlers.js';
import { registerRecordingMeetingHandler, registerRecordingHandlers } from './recording-handlers.js';
import { registerMeetingListHandlers, registerGroupHandlers, registerMeetingHandlers,
  registerImportDroppedHandler } from './meeting-handlers.js';
import { registerSpeakerHandlers } from './speaker-handlers.js';
import { registerActionsListHandler, registerActionItemHandlers } from './action-item-handlers.js';

// IPC registration hub. Domain handlers live in focused modules
// (meeting-, speaker-, recording-, search-, action-item-handlers.ts, and the
// settings/weekly/ask/export/terminology modules); this file keeps the shared
// IpcServices contract and the app-level handlers (version, backup, logs,
// summary templates, Google auth, LLM providers, webhook, pipeline queue,
// transcript export).

export interface IpcServices {
  nativeSpeech?: NativeSpeechService;
  backup?: LibraryBackup;
  notesHistory?: NotesHistory;
  terminology?: TerminologyService;
  meetings: MeetingsRepo;
  groups: GroupsRepo;
  speakers: SpeakersRepo;
  actionItems: ActionItemsRepo;
  stageDurations: StageDurationsRepo;
  settings: SettingsRepo;
  lmStudio: LMStudioClient;
  /** Lazy-spawn supervisor for the summary LLM. reextract calls
   *  ensureReady() before its chat() call, exactly as the extract stage
   *  does — a no-op when provider='external' (user-managed LM Studio).
   *  The model picker calls ensureServerUp() to start the server without
   *  loading a model. */
  llmSupervisor: { ensureReady: (signal?: AbortSignal) => Promise<void>; ensureServerUp: () => Promise<void> };
  recordingManager: RecordingManager;
  recordingRecovery: RecordingRecoveryService;
  appEnumerator: AppEnumerator;
  helperPath: string;
  roster: RosterService;
  pipeline: Pipeline;
  exporters: Record<string, Exporter>;
  libraryRoot: string;
  meetingDetector?: MeetingDetector;
  nativeAppDetector?: NativeAppDetector;
  weeklyAggregator: WeeklyAggregator;
  /** Full-text index behind "ask across meetings"; absent in tests that do not need it. */
  askIndex?: AskIndex;
  logger: Logger;
  /** Per-group and per-meeting summary template choices. */
  summaryTemplates?: SummaryTemplateStore;
  /** Menu-bar item and global record shortcut; absent in tests and CI smoke. */
  menuBar?: { setVisible(visible: boolean): void };
  recordShortcut?: { apply(accelerator: string): void };
  /** Encrypts secret settings and redacts them from renderer snapshots. */
  secrets: SecretSettings;
  googleAuth: GoogleAuth;
  artifactCache: ArtifactCache;
  /** Process-lifetime set of meetings we've already alerted about entering the
   *  speaker-ID gate (see pipeline/gate-alert.ts). Cleared here on the three
   *  unblock paths so a genuine re-entry into the gate notifies again. */
  gateNotified: Set<string>;
}

export function registerIpcHandlers(ipc: IpcMain, s: IpcServices): void {
  const search = registerSearchCancelHandler(ipc);
  if (s.terminology) registerTerminologyHandlers(ipc, s.terminology);
  ipc.handle(IPC_CHANNELS.appGetVersion, () => app.getVersion());
  ipc.handle(IPC_CHANNELS.backupStatus,()=>s.backup?.status??{state:'idle',completed:0,total:0});
  ipc.handle(IPC_CHANNELS.backupPreview,async()=>{
    if(!s.backup)throw new Error('Backup is unavailable.');
    const picked=await dialog.showOpenDialog({title:'Choose where to back up the Library',properties:['openDirectory','createDirectory']});
    if(picked.canceled||!picked.filePaths[0])return null;
    return s.backup.preview(picked.filePaths[0]);
  });
  ipc.handle(IPC_CHANNELS.backupRun,(_event,destination:unknown)=>{
    if(!s.backup)throw new Error('Backup is unavailable.');return s.backup.run(z.string().min(1).max(4000).parse(destination));
  });
  registerRecordingMeetingHandler(ipc, s);

  ipc.handle(IPC_CHANNELS.logsTail, (_e, maxEntries?: unknown) => {
    const n = typeof maxEntries === 'number' && maxEntries > 0
      ? Math.min(maxEntries, 2000)
      : 500;
    return {
      path: s.logger.filePath,
      entries: tailLogFile(s.logger.filePath, { maxEntries: n }),
    };
  });

  ipc.handle(IPC_CHANNELS.logsReveal, () => {
    shell.showItemInFolder(s.logger.filePath);
  });

  // Summary templates (#254). Choosing one never rewrites existing notes; it
  // applies the next time the summarize stage runs for that meeting.
  ipc.handle(IPC_CHANNELS.summaryTemplatesList, () => ({
    templates: SUMMARY_TEMPLATES.map(({ id, name, description }) => ({ id, name, description })),
    groupDefaults: s.summaryTemplates?.groupDefaults() ?? {},
  }));
  ipc.handle(IPC_CHANNELS.summaryTemplatesForMeeting, (_e, meetingId: string) =>
    s.summaryTemplates?.forMeeting(meetingId) ?? null);
  ipc.handle(IPC_CHANNELS.summaryTemplatesSetMeeting, (_e, meetingId: string, templateId: string | null) => {
    if (!s.summaryTemplates) throw new Error('Summary templates are unavailable');
    s.summaryTemplates.setForMeeting(meetingId, templateId);
  });
  ipc.handle(IPC_CHANNELS.summaryTemplatesSetGroup, (_e, groupId: string, templateId: string | null) => {
    if (!s.summaryTemplates) throw new Error('Summary templates are unavailable');
    s.summaryTemplates.setForGroup(groupId, templateId);
  });

  const allowRendererReport = createReportLimiter();
  ipc.handle(IPC_CHANNELS.logsRendererError, (_e, report: unknown) => {
    const entry = normalizeRendererError(report);
    if (entry && allowRendererReport()) s.logger.error('renderer:error', { ...entry });
  });

  ipc.handle(IPC_CHANNELS.googleAuthStart, async () => {
    return s.googleAuth.startSignIn();
  });

  ipc.handle(IPC_CHANNELS.googleAuthStatus, () => ({
    email: s.googleAuth.getConnectedEmail(),
    hasCredentials: s.googleAuth.hasCredentials(),
    signedIn: s.googleAuth.isSignedIn(),
  }));

  ipc.handle(IPC_CHANNELS.googleSignOut, () => {
    s.googleAuth.signOut();
  });

  registerMeetingListHandlers(ipc, s);

  registerGroupHandlers(ipc, s);
  registerActionsListHandler(ipc, s);
  ipc.handle(IPC_CHANNELS.appUndoEdit, (event) => event.sender.undo());
  registerMeetingHandlers(ipc, s);

  registerRecordingHandlers(ipc, s);

  registerSpeakerHandlers(ipc, s);

  registerActionItemHandlers(ipc, s);

  registerExportHandlers(ipc, s);

  registerSettingsHandlers(ipc, s);
  registerSearchQueryHandler(ipc, s, search);

  registerWeeklyHandlers(ipc, s);
  registerAskHandlers(ipc, s);

  // Phase 3 LLM-provider lifecycle. Settings UI calls this to dim
  // managed-mode options when their CLI isn't installed and to show
  // running-status hints.
  ipc.handle(IPC_CHANNELS.llmDetectProviders, async (): Promise<ProviderAvailability> => {
    return detectProviders();
  });

  ipc.handle(IPC_CHANNELS.llmProbe, async (
    _e, url: unknown,
  ): Promise<{ ok: true; models: string[] } | { ok: false; error: string; code?: string }> => {
    if (typeof url !== 'string' || !url) return { ok: false, error: 'invalid url' };
    try {
      const resp = await fetch(`${url.replace(/\/$/, '')}/v1/models`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!resp.ok) return { ok: false, error: `HTTP ${resp.status} from /v1/models` };
      const body = (await resp.json().catch(() => null)) as
        | { data?: { id?: string }[] }
        | null;
      const models = (body?.data ?? [])
        .map((m) => m.id ?? '')
        .filter((id) => id.length > 0);
      return { ok: true, models };
    } catch (e) {
      return probeError(e);
    }
  });

  ipc.handle(IPC_CHANNELS.llmHealthCheckModel, async (_e, modelId: unknown) => {
    if (typeof modelId !== 'string' || modelId.length === 0) throw new Error('invalid model id');
    const checkedAt = new Date().toISOString();
    // Short, representative canary — the exact task shape extract really
    // runs (JSON extraction over a summary, not a raw transcript — see the
    // 2026-07-01-extract-from-summary spec). Small enough that a looping
    // model hits the failure fast rather than after several minutes.
    const canarySummary =
      '## Action Items\n' +
      '- Ship the v2 API — Dan — 2026-07-03\n' +
      '- Write the migration guide — Priya — (no date)';
    let verdict: 'ok' | 'loops';
    try {
      await s.lmStudio.chat({
        model: modelId,
        temperature: 0,
        disableThinking: true,
        reasoningEffort: 'none',
        maxTokens: 1500,
        messages: [
          { role: 'system', content: ACTION_ITEM_SYSTEM_PROMPT },
          { role: 'user', content: canarySummary },
        ],
      });
      verdict = 'ok';
    } catch (e) {
      // Only the specific reasoning-loop failure counts as "loops" — a
      // network error or an unloaded model shouldn't be mislabeled as a
      // reasoning problem.
      if (e instanceof LMStudioError && e.message.includes(REASONING_LOOP_MARKER)) {
        verdict = 'loops';
      } else {
        throw e;
      }
    }
    const result = { verdict, checkedAt };
    const cache = s.settings.get('modelHealthChecks');
    s.settings.set('modelHealthChecks', { ...cache, [modelId]: result });
    return result;
  });

  // Pipeline queue controls. Pause/resume don't touch DB rows — they
  // just gate the runner. clear flips queued meetings back to 'pending'
  // so the user can see them and decide whether to re-process.
  // Webhook test-send (#79). Builds a synthetic meeting.completed payload
  // (same shape the auto-fire produces) and POSTs it via the registered
  // webhook exporter. Surfaces the delivery result so the Settings card
  // can show the same status the user would see for a real meeting.
  ipc.handle(IPC_CHANNELS.webhookTestSend, async () => {
    const webhook = s.exporters.webhook as {
      deliverPayload?: (p: unknown) => Promise<{ ts: string; status: number | null; error: string | null }>;
    } | undefined;
    if (!webhook?.deliverPayload) {
      return { ts: new Date().toISOString(), status: null, error: 'webhook exporter is not configured' };
    }
    const cfg = s.settings.getAll();
    const samplePayload = {
      event: 'meeting.completed' as const,
      meeting: {
        id: 'test-sample',
        slug: '2026-01-01-test-sample',
        title: 'Test payload from MeetingNotes',
        started_at: new Date().toISOString(),
        duration_s: 600,
        attendees: cfg.userName ? [cfg.userName] : ['You'],
      },
      summary_markdown: 'This is a synthetic payload from the Settings test button. No real meeting data is included.',
      transcript_markdown: null,
      action_items: [
        { text: 'Confirm your webhook endpoint received this payload', owner: cfg.userName || 'You', due_date: null },
      ],
      links: {
        audio: null,
        transcript_md: null,
        summary_md: null,
        open_in_app: 'meetingnotes://open?id=test-sample',
      },
    };
    return webhook.deliverPayload(samplePayload);
  });

  ipc.handle(IPC_CHANNELS.pipelineStatus, () => s.pipeline.getStatus());
  ipc.handle(IPC_CHANNELS.pipelineCancel, (_e, id: string) => s.pipeline.cancelCurrent(id));
  ipc.handle(IPC_CHANNELS.pipelinePause, () => { s.pipeline.pause(); });
  ipc.handle(IPC_CHANNELS.pipelineResume, () => { s.pipeline.resume(); });
  ipc.handle(IPC_CHANNELS.pipelineClear, () => {
    const cleared = s.pipeline.clearQueue();
    for (const id of cleared) {
      try { s.meetings.updateStatus(id, 'pending'); } catch { /* best-effort */ }
    }
    return { cleared };
  });

  // Transcript export. Renderer hands us the already-formatted content
  // plus the desired filename + format; we show the native save dialog
  // (filtered to the right extension) and write the file. Keeps fs
  // access out of the renderer and matches the WeeklyView export shape.
  ipc.handle(IPC_CHANNELS.transcriptExport, async (
    _e, input: unknown,
  ): Promise<{ path: string | null }> => {
    const obj = (input ?? {}) as { content?: unknown; defaultName?: unknown; format?: unknown };
    const content = typeof obj.content === 'string' ? obj.content : '';
    const defaultName = typeof obj.defaultName === 'string' && obj.defaultName.trim()
      ? obj.defaultName : 'transcript';
    const format: 'md' | 'txt' = obj.format === 'txt' ? 'txt' : 'md';
    if (!content) throw new Error('transcript:export: empty content');
    const filterName = format === 'md' ? 'Markdown' : 'Plain text';
    const result = await dialog.showSaveDialog({
      defaultPath: `${defaultName}.${format}`,
      filters: [{ name: filterName, extensions: [format] }],
    });
    if (result.canceled || !result.filePath) return { path: null };
    fs.writeFileSync(result.filePath, content, 'utf8');
    return { path: result.filePath };
  });
  registerImportDroppedHandler(ipc, s);
}
