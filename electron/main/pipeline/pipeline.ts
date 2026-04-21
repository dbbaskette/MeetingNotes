// electron/main/pipeline/pipeline.ts
import type { PipelineContext, StageHandler, StageInput } from './context.js';
import { STAGES, previousCompletedOnCrash, type Stage } from '../lib/stage-machine.js';

const LINEAR_STAGES = STAGES.slice(
  STAGES.indexOf('merging'),
  STAGES.indexOf('done'),
) as readonly Exclude<Stage, 'discovered' | 'transcribing' | 'diarizing' | 'done'>[];

// Stages that have a worker — i.e. the pipeline invokes a handler for them.
// `awaiting_speaker_id` is intentionally absent: it's a user-gate, not work.
type WorkStage = Exclude<Stage, 'discovered' | 'done' | 'awaiting_speaker_id'>;

export interface PipelineDeps {
  ctx: PipelineContext;
  stages: Record<WorkStage, StageHandler>;
}

export class Pipeline {
  private queue: string[] = [];
  private running = false;
  private draining = false;

  constructor(private readonly deps: PipelineDeps) {}

  enqueue(meetingId: string): void {
    if (this.draining) return;
    if (!this.queue.includes(meetingId)) this.queue.push(meetingId);
    void this.tick();
  }

  async run(meetingId: string): Promise<void> {
    await this.process(meetingId);
  }

  /** Stop accepting new work; lets the in-flight stage finish. */
  drain(): void {
    this.draining = true;
    this.queue = [];
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0) {
        const id = this.queue.shift()!;
        try {
          await this.process(id);
        } catch (e) {
          // Mark failed and roll the stage back to a safe re-entry point so a
          // future user-initiated rerun starts clean. Recovery skips failed.
          const m = this.deps.ctx.meetings.findById(id);
          if (m) {
            const safe = previousCompletedOnCrash(m.pipelineStage as Stage);
            if (safe !== m.pipelineStage) this.deps.ctx.meetings.updateStage(id, safe);
            this.deps.ctx.meetings.updateStatus(id, 'failed');
          }
          this.deps.ctx.logger.error('pipeline:failure', { id, err: String(e) });
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async process(meetingId: string): Promise<void> {
    const input: StageInput = { meetingId };
    const m = this.deps.ctx.meetings.findById(meetingId);
    if (!m) return;

    // Re-runs / recovery may put status back to 'processing' before enqueueing.
    if (m.status === 'failed') this.deps.ctx.meetings.updateStatus(meetingId, 'processing');

    let stage = m.pipelineStage as Stage;

    // Parallel block: transcribing + diarizing. Treat any of these as a single
    // entry point so a rerun-from-transcribing still produces diarization.
    if (stage === 'discovered' || stage === 'transcribing' || stage === 'diarizing') {
      this.deps.ctx.meetings.updateStage(meetingId, 'transcribing');
      await Promise.all([
        this.deps.stages.transcribing(input, this.deps.ctx),
        this.deps.stages.diarizing(input, this.deps.ctx),
      ]);
      stage = 'merging';
    }

    const startIdx = LINEAR_STAGES.indexOf(stage as (typeof LINEAR_STAGES)[number]);
    if (startIdx >= 0) {
      for (let i = startIdx; i < LINEAR_STAGES.length; i++) {
        const s = LINEAR_STAGES[i]!;
        // Speaker-ID gate: after `identifying` completes, the next entry in
        // LINEAR_STAGES is `awaiting_speaker_id`. It has no handler — this is
        // where we stop so the user can label unknown voices in the UI. When
        // they're done (or flip the per-meeting skip flag), calling
        // `continueFromSpeakerId` in the IPC handlers re-enqueues the meeting
        // with stage='summarizing', which re-enters this loop past the gate.
        if (s === 'awaiting_speaker_id') {
          const fresh = this.deps.ctx.meetings.findById(meetingId);
          if (!fresh?.skipSpeakerId) {
            this.deps.ctx.meetings.updateStage(meetingId, s);
            this.deps.ctx.meetings.updateStatus(meetingId, 'awaiting_user');
            return; // stop; user action re-enqueues
          }
          // Skip flag is set — don't stop. But before summarize reads
          // transcript.md, re-run merging so any roster matches the
          // `identifying` stage auto-made replace SPEAKER_00 with real
          // names in the written transcript. Cheap (no network) and
          // idempotent, safe to run on every exit from the gate.
          await this.deps.stages.merging(input, this.deps.ctx);
          continue;
        }
        this.deps.ctx.meetings.updateStage(meetingId, s);
        await this.deps.stages[s as WorkStage](input, this.deps.ctx);
      }
    }
    this.deps.ctx.meetings.updateStage(meetingId, 'done');
    this.deps.ctx.meetings.updateStatus(meetingId, 'done');
  }
}
