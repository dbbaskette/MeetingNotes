// electron/main/pipeline/context.ts
import type { LMStudioClient } from '../lm-studio/client';
import type { DiarizationClient } from '../diarization/client';
import type { MeetingsRepo } from '../storage/meetings-repo';
import type { SpeakersRepo } from '../storage/speakers-repo';
import type { ActionItemsRepo } from '../storage/action-items-repo';
import type { SettingsRepo } from '../storage/settings-repo';
import type { RosterService } from '../speakers/roster-service';
import type { Logger } from '../logging/logger';

export interface PipelineContext {
  libraryRoot: string;
  lmStudio: LMStudioClient;
  diarization: DiarizationClient;
  meetings: MeetingsRepo;
  speakers: SpeakersRepo;
  actionItems: ActionItemsRepo;
  settings: SettingsRepo;
  roster: RosterService;
  logger: Logger;
}

export interface StageInput {
  meetingId: string;
}
export type StageHandler = (input: StageInput, ctx: PipelineContext) => Promise<void>;
