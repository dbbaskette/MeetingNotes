// electron/main/pipeline/pipeline.ts
import type { PipelineContext, StageHandler, StageInput } from './context.js';
import { STAGES, previousCompletedOnCrash, type Stage } from '../lib/stage-machine.js';
import { bucketForChars } from '../lib/stage-eta.js';
import { transcriptChars } from './transcript-chars.js';

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

/** Reported queue state for the renderer's pause/resume/clear UI. */
export interface PipelineStatus {
  /** True when pause() has been called and tick() is refusing to pull
   *  the next item. The currently-in-flight meeting still finishes. */
  paused: boolean;
  /** ID of the meeting currently being worked on, or null if idle. */
  currentId: string | null;
  /** Number of meetings sitting in the queue, not yet started. */
  queueLength: number;
  /** IDs of queued (not-yet-started) meetings, in order. */
  queueIds: string[];
}

export type PipelineStatusListener = (s: PipelineStatus) => void;
/** Fires when a meeting reaches status='done'. Async listeners are awaited
 *  but their errors are isolated — webhook delivery failures must not
 *  poison the next meeting's run. Issue #79. */
export type MeetingCompleteListener = (meetingId: string) => void | Promise<void>;
/** Fires the instant a meeting enters the `awaiting_speaker_id` gate — the one
 *  place the pipeline stops and waits on the user. The wiring in index.ts uses
 *  it to raise a native notification. Errors thrown by listeners are isolated
 *  so a bad listener can't wedge the pipeline. */
export type SpeakerGateListener = (meetingId: string) => void;

export class Pipeline {
  private queue: string[] = [];
  private running = false;
  private draining = false;
  private paused = false;
  private currentId: string | null = null;
  private readonly statusListeners: Set<PipelineStatusListener> = new Set();
  private readonly completeListeners: Set<MeetingCompleteListener> = new Set();
  private readonly gateListeners: Set<SpeakerGateListener> = new Set();

  constructor(private readonly deps: PipelineDeps) {}

  enqueue(meetingId: string): void {
    if (this.draining) return;
    if (!this.queue.includes(meetingId)) this.queue.push(meetingId);
    this.notify();
    void this.tick();
  }

  async run(meetingId: string): Promise<void> {
    await this.process(meetingId);
  }

  /** Stop accepting new work; lets the in-flight stage finish. Used at
   *  app shutdown — different from pause(), which is user-initiated and
   *  reversible. */
  drain(): void {
    this.draining = true;
    this.queue = [];
    this.notify();
  }

  /** Tell the runner to stop pulling new items off the queue. The
   *  currently in-flight meeting keeps going to completion (or failure)
   *  — we deliberately don't try to abort mid-stage so that long
   *  whisper / pyannote calls aren't wasted. */
  pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.notify();
  }

  /** Resume processing the queue from where pause() left it. */
  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.notify();
    void this.tick();
  }

  /** Drop all queued (not-yet-started) meetings. Their status stays
   *  'processing' on disk if they had it — caller can flip them back
   *  to 'pending' via the IPC layer (which also handles the audit
   *  trail). Returns the IDs that were cleared so the caller can
   *  emit a single targeted status update.
   *
   *  The currently in-flight meeting is NOT touched. */
  clearQueue(): string[] {
    const dropped = this.queue.slice();
    this.queue = [];
    if (dropped.length > 0) this.notify();
    return dropped;
  }

  getStatus(): PipelineStatus {
    return {
      paused: this.paused,
      currentId: this.currentId,
      queueLength: this.queue.length,
      queueIds: this.queue.slice(),
    };
  }

  /** Subscribe to queue-state changes. Called every time the queue,
   *  pause flag, or current-meeting pointer changes. */
  onStatusChange(cb: PipelineStatusListener): () => void {
    this.statusListeners.add(cb);
    return () => { this.statusListeners.delete(cb); };
  }

  /** Subscribe to meeting completions. Fires after the meeting flips to
   *  status='done'. Errors thrown by listeners are logged but don't roll
   *  back the completion. Used by the webhook exporter to push the
   *  meeting.completed payload (#79). */
  onMeetingComplete(cb: MeetingCompleteListener): () => void {
    this.completeListeners.add(cb);
    return () => { this.completeListeners.delete(cb); };
  }

  /** Subscribe to gate entries. Fires once each time a meeting reaches
   *  `awaiting_speaker_id`. Returns an unsubscribe fn. */
  onAwaitingSpeakerId(cb: SpeakerGateListener): () => void {
    this.gateListeners.add(cb);
    return () => { this.gateListeners.delete(cb); };
  }

  private notify(): void {
    const status = this.getStatus();
    for (const cb of this.statusListeners) {
      try { cb(status); } catch { /* listener errors must not break the pipeline */ }
    }
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0) {
        if (this.paused) break;
        const id = this.queue.shift()!;
        this.currentId = id;
        this.notify();
        try {
          await this.process(id);
        } catch (e) {
          // Mark failed and roll the stage back to a safe re-entry point so a
          // future user-initiated rerun starts clean. Recovery skips failed.
          const m = this.deps.ctx.meetings.findById(id);
          if (m) {
            const safe = previousCompletedOnCrash(m.pipelineStage as Stage);
            if (safe !== m.pipelineStage) this.deps.ctx.meetings.updateStage(id, safe);
            // Record WHY it failed so the detail view can show it (and the
            // user can retry) instead of a bare FAILED pill. The stage that
            // threw is also captured by the rolled-back pipeline_stage.
            this.deps.ctx.meetings.recordFailure(id, String(e));
          }
          this.deps.ctx.logger.error('pipeline:failure', { id, err: String(e) });
        } finally {
          this.currentId = null;
          this.notify();
        }
      }
    } finally {
      this.running = false;
      this.notify();
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
        this.timeStage('transcribing', input, m.slug),
        this.timeStage('diarizing', input, m.slug),
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
            // Notify subscribers that this meeting is now blocked on the user.
            // Per-listener isolation matches notify()/complete-listener loops:
            // a throwing listener must not stop us returning to park the gate.
            for (const cb of this.gateListeners) {
              try { cb(meetingId); } catch { /* listener errors must not break the pipeline */ }
            }
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
        await this.timeStage(s as WorkStage, input, m.slug);
      }
    }
    this.deps.ctx.meetings.updateStage(meetingId, 'done');
    this.deps.ctx.meetings.updateStatus(meetingId, 'done');
    for (const cb of this.completeListeners) {
      try {
        await cb(meetingId);
      } catch (e) {
        this.deps.ctx.logger.error('pipeline:complete-listener-error', { id: meetingId, err: String(e) });
      }
    }
  }

  /** Run a stage handler and record its wall-clock duration as an ETA sample,
   *  bucketed by the meeting's transcript size. Timing must never break a real
   *  run: a failing stage records nothing (its time isn't representative), and
   *  a failing telemetry write is logged and swallowed. */
  private async timeStage(stage: WorkStage, input: StageInput, slug: string): Promise<void> {
    const start = performance.now();
    await this.deps.stages[stage](input, this.deps.ctx);
    const durationMs = performance.now() - start;
    try {
      const bucket = bucketForChars(transcriptChars(this.deps.ctx.libraryRoot, slug));
      this.deps.ctx.stageDurations.record(stage, bucket, durationMs);
    } catch (e) {
      this.deps.ctx.logger.error('pipeline:eta-record-failed', { stage, err: String(e) });
    }
  }
}
