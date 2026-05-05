import { z } from 'zod';

export const MeetingSummarySchema = z.object({
  id: z.string(),
  slug: z.string(),
  title: z.string(),
  startedAt: z.string().nullable(),
  durationS: z.number().nullable(),
  pipelineStage: z.string(),
  status: z.string(),
  unidentifiedCount: z.number(),
  actionItemsCount: z.number(),
  skipSpeakerId: z.boolean(),
  speakers: z.array(z.object({
    localLabel: z.string(),
    rosterId: z.string().nullable(),
    displayName: z.string().nullable(),
    confidence: z.number().nullable(),
  })),
});
export type MeetingSummary = z.infer<typeof MeetingSummarySchema>;

export const MeetingDetailSchema = MeetingSummarySchema.extend({
  transcriptMd: z.string().nullable(),
  summaryMd: z.string().nullable(),
  audioPath: z.string(),
  actionItems: z.array(z.object({
    id: z.string(),
    text: z.string(),
    ownerName: z.string().nullable(),
    dueDate: z.string().nullable(),
    status: z.string(),
    exportedTo: z.array(z.string()),
  })),
  models: z.object({ stt: z.string().optional(), llm: z.string().optional() }),
});
export type MeetingDetail = z.infer<typeof MeetingDetailSchema>;

export const IPC_CHANNELS = {
  meetingsList: 'meetings:list',
  meetingsGet: 'meetings:get',
  meetingsRename: 'meetings:rename',
  meetingsDelete: 'meetings:delete',
  meetingsUndoDelete: 'meetings:undo-delete',
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
  permissionsAudioGet: 'permissions:audio-get',
  permissionsRequestMic: 'permissions:request-mic',
  permissionsMicStatus: 'permissions:mic-status',
  speakersList: 'speakers:list',
  speakersConfirm: 'speakers:confirm',
  speakersRename: 'speakers:rename',
  speakersSample: 'speakers:sample',
  speakersAssign: 'speakers:assign',
  speakersUnlink: 'speakers:unlink',
  actionItemsSetStatus: 'action-items:set-status',
  actionItemsUpdate: 'action-items:update',
  actionItemsDelete: 'action-items:delete',
  actionItemsCreate: 'action-items:create',
  exportRun: 'export:run',
  dialogSave: 'dialog:save',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  modelsList: 'models:list',
  meetingDetectedEvent: 'meeting-detector:detected',
  meetingDetectorDismiss: 'meeting-detector:dismiss',
  onboardingWhisperList: 'onboarding:whisper-list',
  onboardingWhisperInstall: 'onboarding:whisper-install',
  onboardingHfTokenSave: 'onboarding:hf-token-save',
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
} as const;
