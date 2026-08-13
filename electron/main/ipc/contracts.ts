import { z } from 'zod';

const MeetingSpeakerSchema = z.object({
  localLabel: z.string(),
  rosterId: z.string().nullable(),
  displayName: z.string().nullable(),
  confidence: z.number().nullable(),
});

export const MeetingSummarySchema = z.object({
  id: z.string(),
  slug: z.string(),
  title: z.string(),
  startedAt: z.string().nullable(),
  durationS: z.number().nullable(),
  pipelineStage: z.string(),
  status: z.string(),
  /** When status === 'failed', the error string from the stage that threw
   *  (e.g. "whisper: not ready ..."). Null otherwise. Powers the failure
   *  banner + Retry affordance in the detail view. */
  errorMessage: z.string().nullable(),
  unidentifiedCount: z.number(),
  actionItemsCount: z.number(),
  /** Learned estimate (ms) for the meeting's CURRENT stage, or null on a cold
   *  start / non-work stage. The renderer shows it next to elapsed time
   *  ("summarize — 1m 40s · ~3m"). Median of recent same-size samples on this
   *  machine; see stage-eta.ts. */
  stageEtaMs: z.number().nullable(),
  /** True when stageEtaMs was derived from fewer than 3 samples, so the UI
   *  hedges it ("~3m (rough)"). Always false when stageEtaMs is null. */
  stageEtaRough: z.boolean(),
  skipSpeakerId: z.boolean(),
  speakers: z.array(MeetingSpeakerSchema),
});
export type MeetingSummary = z.infer<typeof MeetingSummarySchema>;

export const MeetingDetailSchema = MeetingSummarySchema.extend({
  speakers: z.array(MeetingSpeakerSchema.extend({
    state: z.enum(['unknown', 'probable', 'confirmed']),
    needsReview: z.boolean(),
    segmentCount: z.number(),
    durationS: z.number(),
    lineCount: z.number(),
  })),
  transcriptMd: z.string().nullable(),
  summaryMd: z.string().nullable(),
  audioPath: z.string(),
  /** True when the user has set Settings → "You are…" (userSpeakerId).
   *  Task-app exports (Reminders, Google Tasks) require it. */
  userIdentified: z.boolean(),
  actionItems: z.array(z.object({
    id: z.string(),
    text: z.string(),
    ownerName: z.string().nullable(),
    dueDate: z.string().nullable(),
    status: z.string(),
    exportedTo: z.array(z.string()),
    /** True when this item is owned by the user (by roster id or owner
     *  name). Drives the task-app export modal, which lists only my items. */
    isMine: z.boolean(),
  })),
  models: z.object({ stt: z.string().optional(), llm: z.string().optional() }),
});
export type MeetingDetail = z.infer<typeof MeetingDetailSchema>;

export const IPC_CHANNELS = {
  meetingsList: 'meetings:list',
  meetingsGet: 'meetings:get',
  /** Light status poll for the detail view while a meeting is processing.
   *  Returns only the DB-backed live fields (stage/status/error/eta/counts)
   *  — never the transcript/summary markdown that meetings:get reads off
   *  disk, so the 2s poll doesn't ship hundreds of KB per tick. */
  meetingsGetStatus: 'meetings:get-status',
  meetingsRename: 'meetings:rename',
  meetingsDelete: 'meetings:delete',
  meetingsUndoDelete: 'meetings:undo-delete',
  /** List soft-deleted meetings still inside the trash retention window
   *  (id, title, deletedAt — newest first). Purges expired entries before
   *  answering so the "Recently deleted" UI never shows a meeting whose
   *  files are already gone. Restore goes through meetings:undo-delete. */
  trashList: 'trash:list',
  meetingsRerun: 'meetings:rerun',
  meetingsStart: 'meetings:start',
  meetingsStartMany: 'meetings:start-many',
  meetingsSetSkipSpeakerId: 'meetings:set-skip-speaker-id',
  meetingsContinueFromSpeakerId: 'meetings:continue-from-speaker-id',
  meetingsSaveSummary: 'meetings:save-summary',
  recordingListSources: 'recording:list-sources',
  recordingStart: 'recording:start',
  recordingStop: 'recording:stop',
  recordingState: 'recording:state',
  recordingLevelEvent: 'recording:level',
  recordingStateEvent: 'recording:state-change',
  recoveryList: 'recovery:list',
  recoveryRecover: 'recovery:recover',
  recoveryTrim: 'recovery:trim',
  recoveryReveal: 'recovery:reveal',
  recoveryDismiss: 'recovery:dismiss',
  permissionsAudioGet: 'permissions:audio-get',
  permissionsRequestMic: 'permissions:request-mic',
  permissionsMicStatus: 'permissions:mic-status',
  speakersList: 'speakers:list',
  speakersConfirm: 'speakers:confirm',
  speakersRename: 'speakers:rename',
  /** Merge one roster speaker into another (duplicate cleanup). All meeting
   *  links + action-item ownership move source → target, the source roster
   *  row is deleted, and every affected meeting's transcript.md is re-merged
   *  so the surviving name appears in the output. */
  speakersMerge: 'speakers:merge',
  speakersSample: 'speakers:sample',
  speakersAssign: 'speakers:assign',
  speakersAssignBulk: 'speakers:assign-bulk',
  speakersSuggestions: 'speakers:suggestions',
  speakersUnlink: 'speakers:unlink',
  actionItemsSetStatus: 'action-items:set-status',
  actionItemsUpdate: 'action-items:update',
  actionItemsDelete: 'action-items:delete',
  actionItemsCreate: 'action-items:create',
  /** Re-run ONLY the extract step against the current on-disk summary.md and
   *  replace the meeting's action items. Does NOT touch pipeline state — a
   *  'done' meeting stays 'done'. Used by the Action Items panel's Re-extract
   *  button after the user edits + saves the summary. Returns { count }. */
  actionItemsReextract: 'action-items:reextract',
  exportRun: 'export:run',
  dialogSave: 'dialog:save',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  /** Reveal a storage location in Finder. Arg is a StorageLocationKey
   *  ('library'|'models'|'logs'|'hfCache'); main resolves the path via
   *  storageLocations(), mkdir -p's it, and shell.showItemInFolder()s it. */
  settingsRevealStorage: 'settings:reveal-storage',
  modelsList: 'models:list',
  meetingDetectedEvent: 'meeting-detector:detected',
  meetingDetectorDismiss: 'meeting-detector:dismiss',
  onboardingWhisperList: 'onboarding:whisper-list',
  onboardingWhisperInstall: 'onboarding:whisper-install',
  /** Push channel: byte-level progress for an in-flight whisper model
   *  download. Payload: { model, received, total } — total is null when
   *  the host omitted content-length. ~4 events/sec (throttled in
   *  download-model.ts). */
  onboardingWhisperProgress: 'onboarding:whisper-progress',
  onboardingHfTokenSave: 'onboarding:hf-token-save',
  onboardingHfTokenStatus: 'onboarding:hf-token-status',
  onboardingOpenExternal: 'onboarding:open-external',
  searchQuery: 'search:query',
  weeklyGet: 'weekly:get',
  weeklyGetStructured: 'weekly:get-structured',
  weeklyGetNarrative: 'weekly:get-narrative',
  weeklyRegenerate: 'weekly:regenerate',
  weeklyExportMarkdown: 'weekly:export-markdown',
  llmDetectProviders: 'llm:detect-providers',
  /** Probe a custom STT URL for whisper-server's /health JSON. Used
   *  by the Settings "Test" button so users can validate their
   *  endpoint before walking into a 5–15 min pipeline run with a
   *  misconfigured server. */
  sttProbe: 'stt:probe',
  /** Probe a custom LLM URL for /v1/models. Returns the loaded
   *  model ids, or an error string. Same Settings "Test" button. */
  llmProbe: 'llm:probe',
  /** Fire one cheap canary extraction prompt at a model through the real
   *  chat path and report whether it answered ('ok') or looped without
   *  output ('loops'). Lets Settings warn at model-selection time. */
  llmHealthCheckModel: 'llm:health-check-model',
  /** Drag-and-drop import: copies the given absolute file paths
   *  into audioWatchPath (the chokidar-watched folder), where the
   *  existing watcher picks them up as new pending meetings.
   *  Returns the number imported and any per-file errors. */
  meetingsImportDropped: 'meetings:import-dropped',
  /** Save a pre-rendered transcript export to disk. Renderer formats
   *  the content (so the active per-line/grouped view choice flows
   *  through), main does the dialog + file write so we don't ship
   *  raw fs access into the renderer. */
  transcriptExport: 'transcript:export',
  /** Pause the queue runner — current meeting finishes; nothing new
   *  starts until resume. Idempotent. */
  pipelinePause: 'pipeline:pause',
  /** Resume the queue runner. Idempotent. */
  pipelineResume: 'pipeline:resume',
  /** Drop all queued (not-yet-started) meetings. Returns the IDs that
   *  were cleared so the renderer can flip their status back to
   *  'pending' for the user. */
  pipelineClear: 'pipeline:clear',
  /** Snapshot of paused / currentId / queueLength. Renderer polls this
   *  alongside its meetings refresh. */
  pipelineStatus: 'pipeline:status',
  /** Push channel: main broadcasts a new PipelineStatus on every queue
   *  state change (enqueue, dequeue, pause, resume, clear). */
  pipelineStatusEvent: 'pipeline:status-change',
  /** Push channel: main broadcasts {id} when the library watcher inserts
   *  a brand-new meeting row (e.g. just after a recording stops and the
   *  .m4a goes stable on disk). Renderer uses it to refresh the Library
   *  immediately instead of waiting for the next 3s poll tick — which
   *  doesn't fire when hasMotion is false, leaving the list visibly
   *  stale until a remount. */
  meetingsAddedEvent: 'meetings:added',
  appGetVersion: 'app:get-version',
  /** Read the tail of the app log as parsed JSON-lines entries for the
   *  in-app Diagnostics view. Bounded read — never loads the whole file. */
  logsTail: 'logs:tail',
  /** Reveal the app log file in Finder. */
  logsReveal: 'logs:reveal',
  /** Begin the Google OAuth sign-in flow (opens the system browser). Resolves
   *  with the connected account email. */
  googleAuthStart: 'google:auth-start',
  /** { email, hasCredentials, signedIn } snapshot for the Settings card. */
  googleAuthStatus: 'google:auth-status',
  /** Disconnect the Google account (clears stored tokens). */
  googleSignOut: 'google:sign-out',
  /** Fire a synthetic meeting.completed payload at the configured
   *  webhook URL. Used by the Settings "Send test payload" button so
   *  the user can verify their endpoint before a real meeting runs.
   *  Returns the delivery result so the UI can display status. (#79) */
  webhookTestSend: 'webhook:test-send',
} as const;
