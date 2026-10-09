// electron/main/ipc/channel-schemas.ts
//
// One argument schema per invokable IPC channel (#256). `validateIpc` wraps
// ipcMain so every handler's arguments are checked against this table before
// the handler runs, and a handler cannot be registered without an entry.
//
// The table fixes each channel's arity and the type of every primitive
// argument. Structured payloads that already have a dedicated schema next to
// their handler are marked `handlerValidated`: they stay `unknown` here so the
// two definitions cannot drift, and the handler remains the authority for
// their shape. Handlers that had no validation of their own get a full schema
// here.

import type { IpcMain } from 'electron';
import { z } from 'zod';
import { IPC_CHANNELS } from './contracts.js';

const C = IPC_CHANNELS;

/** Meeting, speaker, session, rule and similar identifiers. */
const Id = z.string().min(1).max(200);
const Label = z.string().min(1).max(200);
/** Free text the handler bounds further where it matters. */
const Text = z.string().max(100_000);
/** Notes and transcripts. */
const Document = z.string().max(20_000_000);
const handlerValidated = z.unknown();
const none = z.tuple([]);

const WeekArgs = [z.number().int(), z.number().int()] as const;

const DialogSaveOptions = z.object({
  defaultPath: z.string().max(4096).optional(),
  filters: z.array(z.object({ name: z.string().max(100), extensions: z.array(z.string().max(20)).max(20) })).max(20).optional(),
}).optional();

const ExportRunInput = z.object({
  exporter: z.string().min(1).max(100),
  meetingId: Id,
  itemIds: z.array(Id).max(5000).optional(),
  outputPath: z.string().max(4096).optional(),
});

const TranscriptExportInput = z.object({
  content: Document,
  defaultName: z.string().max(500).optional(),
  format: z.enum(['md', 'txt']).optional(),
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous tuples share no narrower common type
type ArgSchema = z.ZodTuple<any, any>;

export const IPC_ARG_SCHEMAS: Record<string, ArgSchema> = {
  // App, logs, backup
  [C.appGetVersion]: none,
  [C.appUndoEdit]: none,
  [C.logsTail]: z.tuple([z.number().optional()]),
  [C.logsReveal]: none,
  [C.logsRendererError]: z.tuple([handlerValidated]),
  [C.backupPreview]: none,
  [C.backupRun]: z.tuple([z.string().min(1).max(4000)]),
  [C.backupStatus]: none,
  [C.setupHealth]: none,
  [C.dialogSave]: z.tuple([DialogSaveOptions]),

  // Meetings
  [C.meetingsList]: none,
  [C.meetingsListPage]: z.tuple([handlerValidated]),
  [C.meetingsGetMany]: z.tuple([handlerValidated, z.object({ shell: z.boolean().optional() }).optional()]),
  [C.meetingsListIds]: z.tuple([handlerValidated, Id.nullable().optional()]),
  [C.meetingsGet]: z.tuple([Id]),
  [C.meetingsGetTranscript]: z.tuple([Id]),
  [C.meetingsGetSpeakerReview]: z.tuple([Id]),
  [C.meetingsGetStatus]: z.tuple([Id]),
  [C.meetingsRename]: z.tuple([Id, Text]),
  [C.meetingsDelete]: z.tuple([Id]),
  [C.meetingsUndoDelete]: z.tuple([Id]),
  [C.meetingsRerun]: z.tuple([Id, z.string().min(1).max(100)]),
  [C.meetingsStart]: z.tuple([Id]),
  [C.meetingsStartMany]: z.tuple([handlerValidated]),
  [C.meetingsStartManyDetailed]: z.tuple([handlerValidated]),
  [C.meetingsSetSkipSpeakerId]: z.tuple([Id, z.boolean()]),
  [C.meetingsContinueFromSpeakerId]: z.tuple([Id]),
  [C.meetingsSaveSummary]: z.tuple([Id, Document]),
  [C.meetingsImportDropped]: z.tuple([handlerValidated]),
  [C.transcriptExport]: z.tuple([TranscriptExportInput]),
  [C.trashList]: none,
  [C.notesHistoryList]: z.tuple([Id]),
  [C.notesHistoryCompare]: z.tuple([Id, handlerValidated]),
  [C.notesHistoryRestore]: z.tuple([Id, handlerValidated, handlerValidated]),

  // Groups
  [C.groupsList]: none,
  [C.groupsCreate]: z.tuple([handlerValidated]),
  [C.groupsRename]: z.tuple([Id, handlerValidated]),
  [C.groupsDelete]: z.tuple([Id]),
  [C.groupsAssign]: z.tuple([handlerValidated]),
  [C.groupsUndo]: z.tuple([handlerValidated]),

  // Recording and recovery
  [C.recordingListSources]: none,
  [C.recordingStart]: z.tuple([handlerValidated]),
  [C.recordingStop]: z.tuple([Id]),
  [C.recordingState]: z.tuple([Id]),
  [C.recordingActive]: none,
  [C.recordingMeeting]: z.tuple([Id]),
  [C.recordingTest]: z.tuple([handlerValidated]),
  [C.recoveryList]: z.tuple([z.string().max(100).optional()]),
  [C.recoveryRecover]: z.tuple([Id]),
  [C.recoveryTrim]: z.tuple([handlerValidated]),
  [C.recoveryPreview]: z.tuple([Id]),
  [C.recoveryReveal]: z.tuple([Id]),
  [C.recoveryDismiss]: z.tuple([Id]),
  [C.meetingDetectorDismiss]: z.tuple([handlerValidated]),
  [C.permissionsAudioGet]: none,
  [C.permissionsMicStatus]: none,
  [C.permissionsRequestMic]: none,

  // Speakers and action items
  [C.speakersList]: none,
  [C.speakersConfirm]: z.tuple([handlerValidated]),
  [C.speakersRename]: z.tuple([Id, Label]),
  [C.speakersMerge]: z.tuple([Id, Id]),
  [C.speakersSample]: z.tuple([Id, Label]),
  [C.speakersAssign]: z.tuple([handlerValidated]),
  [C.speakersAssignBulk]: z.tuple([handlerValidated]),
  [C.speakersSuggestions]: z.tuple([Id, Label]),
  [C.speakersUnlink]: z.tuple([Id, Label]),
  [C.actionItemsSetStatus]: z.tuple([Id, handlerValidated]),
  [C.actionItemsUpdate]: z.tuple([Id, handlerValidated]),
  [C.actionItemsDelete]: z.tuple([Id]),
  [C.actionItemsUndoDelete]: z.tuple([z.string().min(1).max(100)]),
  [C.actionItemsCreate]: z.tuple([Id, handlerValidated]),
  [C.actionItemsReextract]: z.tuple([Id]),

  // Search, pipeline, models
  [C.searchQuery]: z.tuple([Text, z.number().optional(), Id.nullable().optional(), handlerValidated]),
  [C.searchCancel]: z.tuple([handlerValidated]),
  [C.pipelineStatus]: none,
  [C.pipelinePause]: none,
  [C.pipelineResume]: none,
  [C.pipelineClear]: none,
  [C.modelsList]: none,
  [C.llmDetectProviders]: none,
  [C.llmProbe]: z.tuple([z.string().max(4096).optional()]),
  [C.llmHealthCheckModel]: z.tuple([z.string().min(1).max(500)]),
  [C.sttProbe]: z.tuple([z.string().max(4096).optional()]),

  // Exports and integrations
  [C.exportRun]: z.tuple([ExportRunInput]),
  [C.webhookTestSend]: none,
  [C.googleAuthStart]: none,
  [C.googleAuthStatus]: none,
  [C.googleSignOut]: none,
  [C.obsidianStatus]: none,
  [C.obsidianChoose]: none,
  [C.obsidianPreview]: z.tuple([handlerValidated]),
  [C.obsidianEnable]: z.tuple([z.string().uuid()]),
  [C.obsidianDisable]: none,
  [C.obsidianOpen]: none,
  [C.obsidianRepair]: none,
  [C.obsidianRetry]: z.tuple([z.boolean().optional()]),
  [C.obsidianCompare]: z.tuple([Id]),
  [C.obsidianExportComparison]: z.tuple([Id]),
  [C.obsidianReplace]: z.tuple([Id, handlerValidated]),

  // Summary templates
  [C.summaryTemplatesList]: none,
  [C.summaryTemplatesForMeeting]: z.tuple([Id]),
  [C.summaryTemplatesSetMeeting]: z.tuple([Id, z.string().min(1).max(100).nullable()]),
  [C.summaryTemplatesSetGroup]: z.tuple([Id, z.string().min(1).max(100).nullable()]),

  // Weekly
  [C.weeklyGet]: z.tuple([...WeekArgs]),
  [C.weeklyGetStructured]: z.tuple([...WeekArgs]),
  [C.weeklyGetNarrative]: z.tuple([...WeekArgs, z.boolean().optional()]),
  [C.weeklyRegenerate]: z.tuple([...WeekArgs]),
  [C.weeklyExportMarkdown]: z.tuple([...WeekArgs]),

  // Settings, onboarding, terminology
  [C.settingsGet]: none,
  [C.settingsSet]: z.tuple([z.string().min(1).max(100), handlerValidated]),
  [C.settingsChooseFolder]: none,
  [C.settingsRevealStorage]: z.tuple([z.string().min(1).max(100)]),
  [C.onboardingWhisperList]: none,
  [C.onboardingWhisperInstall]: z.tuple([z.string().min(1).max(200)]),
  [C.onboardingHfTokenSave]: z.tuple([z.string().min(8).max(1000)]),
  [C.onboardingHfTokenStatus]: none,
  [C.onboardingOpenExternal]: z.tuple([z.string().min(1).max(4096)]),
  [C.terminologyList]: none,
  [C.terminologySave]: z.tuple([handlerValidated, Id.optional()]),
  [C.terminologyDelete]: z.tuple([Id]),
  [C.terminologyOffers]: z.tuple([z.boolean().optional()]),
  [C.terminologyPreview]: z.tuple([handlerValidated]),
  [C.terminologyCommit]: z.tuple([handlerValidated]),
  [C.terminologyUndo]: z.tuple([handlerValidated]),
};

/** Checks `args` for `channel`. Returns null when valid, else a message that
 *  names the argument position and problem but never echoes a value. */
export function checkIpcArgs(channel: string, args: unknown[]): string | null {
  const schema = IPC_ARG_SCHEMAS[channel];
  if (!schema) return `No argument schema for ${channel}`;
  // A trailing optional argument may be omitted entirely by the caller.
  const expected = schema.items.length;
  const padded = args.length < expected ? [...args, ...new Array<undefined>(expected - args.length).fill(undefined)] : args;
  const result = schema.safeParse(padded);
  if (result.success) return null;
  const issue = result.error.issues[0];
  const where = issue && issue.path.length ? `argument ${issue.path.join('.')}` : 'arguments';
  return `Invalid ${where} for ${channel}: ${issue?.message ?? 'malformed'}`;
}

/** Wraps ipcMain so every handler validates its arguments first. Registering
 *  a channel with no schema throws immediately, so a new handler cannot ship
 *  unvalidated. Handlers receive the original arguments unchanged. */
export function validateIpc(ipc: IpcMain): IpcMain {
  return new Proxy(ipc, {
    get(target, key) {
      if (key !== 'handle') {
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return (channel: string, listener: Parameters<IpcMain['handle']>[1]): void => {
        if (!IPC_ARG_SCHEMAS[channel]) throw new Error(`No argument schema for IPC channel ${channel}; add one to channel-schemas.ts`);
        target.handle(channel, (event, ...args) => {
          const problem = checkIpcArgs(channel, args);
          if (problem) throw new Error(problem);
          return listener(event, ...args);
        });
      };
    },
  });
}
