// electron/main/pipeline/context.ts
import type { LMStudioClient } from '../lm-studio/client.js';
import type { DiarizationClient } from '../diarization/client.js';
import type { ManagedService } from '../lib/managed-service.js';
import type { MeetingsRepo } from '../storage/meetings-repo.js';
import type { SpeakersRepo } from '../storage/speakers-repo.js';
import type { ActionItemsRepo } from '../storage/action-items-repo.js';
import type { SettingsRepo } from '../storage/settings-repo.js';
import type { StageDurationsRepo } from '../storage/stage-durations-repo.js';
import type { RosterService } from '../speakers/roster-service.js';
import type { Logger } from '../logging/logger.js';

export interface PipelineContext {
  libraryRoot: string;
  /** Chat/LLM endpoint (LM Studio). */
  lmStudio: LMStudioClient;
  /** Whisper STT endpoint (whisper.cpp's whisper-server or compatible). */
  stt: LMStudioClient;
  diarization: DiarizationClient;
  /** Lazy-spawn supervisor for the pyannote sidecar. Stages call
   *  `await diarSupervisor.ensureReady()` before invoking
   *  `diarization.diarize()`. Wakes the process on demand and shuts
   *  it down after idle timeout. */
  diarSupervisor: ManagedService;
  /** Lazy-spawn supervisor for whisper-server. Stages call
   *  `await whisperSupervisor.ensureReady()` before invoking
   *  `stt.transcribe()`. */
  whisperSupervisor: ManagedService;
  /** Lazy-spawn supervisor for the summarization LLM (LM Studio /
   *  Ollama). When provider='external', ensureReady() is a no-op
   *  and the existing user-managed flow continues unchanged.
   *  Stages call `await llmSupervisor.ensureReady()` before
   *  invoking `lmStudio.chat()`. */
  llmSupervisor: { ensureReady: () => Promise<void> };
  meetings: MeetingsRepo;
  speakers: SpeakersRepo;
  actionItems: ActionItemsRepo;
  settings: SettingsRepo;
  /** Per-stage duration samples for the learned ETA. The runner records one
   *  sample per successful stage; the IPC layer reads recent samples to
   *  compute the estimate shown next to elapsed time. */
  stageDurations: StageDurationsRepo;
  roster: RosterService;
  logger: Logger;
}

export interface StageInput {
  meetingId: string;
}
export type StageHandler = (input: StageInput, ctx: PipelineContext) => Promise<void>;
