// electron/main/pipeline/pipeline.ts
import type { PipelineContext, StageHandler, StageInput } from './context';
import type { Stage } from '../lib/stage-machine';

export interface PipelineDeps {
  ctx: PipelineContext;
  stages: Record<Exclude<Stage, 'discovered' | 'done'>, StageHandler>;
}

export class Pipeline {
  private queue: string[] = [];
  private running = false;

  constructor(private readonly deps: PipelineDeps) {}

  enqueue(meetingId: string): void {
    if (!this.queue.includes(meetingId)) this.queue.push(meetingId);
    void this.tick();
  }

  async run(meetingId: string): Promise<void> {
    await this.process(meetingId);
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0) {
        const id = this.queue.shift()!;
        try { await this.process(id); }
        catch (e) { this.deps.ctx.logger.error('pipeline:failure', { id, err: String(e) }); }
      }
    } finally { this.running = false; }
  }

  private async process(meetingId: string): Promise<void> {
    const input: StageInput = { meetingId };
    const m = this.deps.ctx.meetings.findById(meetingId);
    if (!m) return;

    let stage = m.pipelineStage as Stage;

    if (stage === 'discovered') {
      this.deps.ctx.meetings.updateStage(meetingId, 'transcribing');
      await Promise.all([
        this.deps.stages.transcribing(input, this.deps.ctx),
        this.deps.stages.diarizing(input, this.deps.ctx),
      ]);
      stage = 'merging';
    } else if (stage === 'transcribing' || stage === 'diarizing') {
      this.deps.ctx.meetings.updateStage(meetingId, stage);
      if (stage === 'transcribing') await this.deps.stages.transcribing(input, this.deps.ctx);
      if (stage === 'diarizing') await this.deps.stages.diarizing(input, this.deps.ctx);
      stage = 'merging';
    }

    const linear = ['merging', 'identifying', 'summarizing', 'extracting'] as const;
    const startIdx = linear.indexOf(stage as (typeof linear)[number]);
    if (startIdx >= 0) {
      for (let i = startIdx; i < linear.length; i++) {
        const s = linear[i]!;
        this.deps.ctx.meetings.updateStage(meetingId, s);
        await this.deps.stages[s](input, this.deps.ctx);
      }
    }
    this.deps.ctx.meetings.updateStage(meetingId, 'done');
    this.deps.ctx.meetings.updateStatus(meetingId, 'done');
  }
}
