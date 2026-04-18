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
  recordStart: 'record:start',
  recordStop: 'record:stop',
  recordState: 'record:state',
  speakersList: 'speakers:list',
  speakersConfirm: 'speakers:confirm',
  speakersRename: 'speakers:rename',
  actionItemsSetStatus: 'action-items:set-status',
  exportRun: 'export:run',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  modelsList: 'models:list',
} as const;
