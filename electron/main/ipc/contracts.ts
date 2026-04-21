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
  speakersList: 'speakers:list',
  speakersConfirm: 'speakers:confirm',
  speakersRename: 'speakers:rename',
  speakersSample: 'speakers:sample',
  speakersAssign: 'speakers:assign',
  speakersUnlink: 'speakers:unlink',
  actionItemsSetStatus: 'action-items:set-status',
  exportRun: 'export:run',
  dialogSave: 'dialog:save',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  modelsList: 'models:list',
} as const;
