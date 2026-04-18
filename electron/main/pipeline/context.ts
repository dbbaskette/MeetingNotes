// electron/main/pipeline/context.ts
import type { LMStudioClient } from '../lm-studio/client.js';
import type { DiarizationClient } from '../diarization/client.js';
import type { MeetingsRepo } from '../storage/meetings-repo.js';
import type { SpeakersRepo } from '../storage/speakers-repo.js';
import type { ActionItemsRepo } from '../storage/action-items-repo.js';
import type { SettingsRepo } from '../storage/settings-repo.js';
import type { RosterService } from '../speakers/roster-service.js';
import type { Logger } from '../logging/logger.js';

export interface PipelineContext {
  libraryRoot: string;
  /** Chat/LLM endpoint (LM Studio). */
  lmStudio: LMStudioClient;
  /** Whisper STT endpoint (whisper.cpp's whisper-server or compatible). */
  stt: LMStudioClient;
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
