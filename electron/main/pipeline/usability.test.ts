import { afterEach, beforeEach, expect, it } from 'vitest';
import { openDb } from '../storage/db.js';
import { MeetingsRepo } from '../storage/meetings-repo.js';
import { SpeakersRepo } from '../storage/speakers-repo.js';
import { Pipeline, type PipelineDeps } from './pipeline.js';
import type { PipelineContext } from './context.js';
import { sequentialSpeech } from './speech-scheduling.js';
let db: ReturnType<typeof openDb>, meetings: MeetingsRepo;
beforeEach(() => { db = openDb(':memory:'); meetings = new MeetingsRepo(db); });
afterEach(() => db.close());
const noop = async (): Promise<void> => {};
function fixture(id: string, durationS = 7200): void {
  meetings.insert({ id, slug: id, title: id, audioPath: '/synthetic', startedAt: null, durationS, status: 'processing', pipelineStage: 'discovered' });
  meetings.updateSkipSpeakerId(id, true);
}
function context(): PipelineContext { return { meetings, libraryRoot: '/tmp', speakers: new SpeakersRepo(db), settings: { get: () => false }, logger: { info() {}, error() {}, warn() {} } } as unknown as PipelineContext; }
const stages = (): PipelineDeps['stages'] => ({ transcribing: noop, diarizing: noop, merging: noop, identifying: noop, summarizing: noop, extracting: noop });
it('serializes long recordings and exposes separate completion states', async () => {
  fixture('long'); const work = stages(); let active = 0, peak = 0; const states: string[] = [];
  const simulatedModel = async (): Promise<void> => { active++; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 5)); active--; };
  work.transcribing = simulatedModel; work.diarizing = simulatedModel;
  const pipeline = new Pipeline({ ctx: context(), stages: work });
  pipeline.onStatusChange(status => { if (status.speechWork) states.push(`${status.speechWork.transcription}/${status.speechWork.speakers}`); });
  await pipeline.run('long');
  expect(peak).toBe(1); expect(states).toContain('complete/waiting'); expect(states).toContain('complete/running'); expect(states).toContain('complete/complete');
  expect(sequentialSpeech(600, 8 * 1024 ** 3)).toBe(false); expect(sequentialSpeech(600, 1024 ** 3)).toBe(true);
});
it('cancels only the selected current meeting and allows the queued meeting to finish', async () => {
  fixture('cancel'); fixture('next'); const work = stages(); let signal: AbortSignal | undefined;
  let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
  work.transcribing = async ({ meetingId }, ctx) => {
    if (meetingId !== 'cancel') return;
    signal = ctx.signal; started();
    await new Promise((_, reject) => ctx.signal!.addEventListener('abort', () => reject(ctx.signal!.reason), { once: true }));
  };
  const pipeline = new Pipeline({ ctx: context(), stages: work });
  const done = new Promise<void>(resolve => pipeline.onMeetingComplete(id => { if (id === 'next') resolve(); }));
  pipeline.enqueue('cancel'); pipeline.enqueue('next'); await ready;
  expect(() => pipeline.cancelCurrent('next')).toThrow(/no longer/);
  pipeline.cancelCurrent('cancel'); await done;
  expect(signal?.aborted).toBe(true); expect(meetings.findById('cancel')?.status).toBe('failed');
  expect(meetings.findById('next')?.status).toBe('done');
});
it('notes-first continues without marking unknown voices confirmed', async () => {
  fixture('notes'); meetings.updateSkipSpeakerId('notes', false);
  const ctx = context(); ctx.settings = { get: (key: string) => key === 'notesFirst' } as PipelineContext['settings'];
  ctx.speakers.linkToMeeting('notes', 'SPEAKER_00', null, 0);
  const pipeline = new Pipeline({ ctx, stages: stages() }); await pipeline.run('notes');
  expect(meetings.findById('notes')?.status).toBe('done');
  expect(ctx.speakers.listForMeeting('notes')[0]?.rosterSpeakerId).toBeNull();
});
