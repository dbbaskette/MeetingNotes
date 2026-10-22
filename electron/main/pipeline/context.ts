// electron/main/pipeline/context.ts
import type { LMStudioClient } from '../lm-studio/client.js';
import type { MeetingsRepo } from '../storage/meetings-repo.js';
import type { SpeakersRepo } from '../storage/speakers-repo.js';
import type { ActionItemsRepo } from '../storage/action-items-repo.js';
import type { SettingsRepo } from '../storage/settings-repo.js';
import type { StageDurationsRepo } from '../storage/stage-durations-repo.js';
import type { RosterService } from '../speakers/roster-service.js';
import type { Logger } from '../logging/logger.js';
import type { ArtifactCache } from '../library/artifact-cache.js';
import type { TerminologyService } from '../terminology/service.js';
import type { NotesHistory } from '../storage/notes-history.js';
import type { SummaryTemplate } from '../../shared/summary-templates.js';
import type { NativeSpeechService } from '../speech/service.js';
import type { SpeechSelection } from '../../shared/native-speech.js';

export interface PipelineContext {
  signal?: AbortSignal;
  onTranscriptionProgress?: (fraction: number) => void;
  nativeSpeech?: NativeSpeechService;
  speechSelection?: SpeechSelection;
  /** Resolves the summary template for a meeting (its own choice, its
   *  group's default, or General). Absent in tests: General is used. */
  summaryTemplateFor?: (meetingId: string) => SummaryTemplate;
  notesHistory?: NotesHistory;
  terminology?: TerminologyService;
  libraryRoot: string;
  artifactCache: ArtifactCache;
  /** Chat/LLM endpoint (LM Studio). */
  lmStudio: LMStudioClient;
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
