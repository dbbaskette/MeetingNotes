import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../storage/db.js';
import { MeetingsRepo } from '../storage/meetings-repo.js';
import { SpeakersRepo } from '../storage/speakers-repo.js';
import { ArtifactCache } from '../library/artifact-cache.js';
import { meetingFolderPath } from '../storage/meeting-folder.js';
import { remergeTranscript } from './stages/merging.js';
import { Pipeline } from './pipeline.js';
import type { PipelineContext, StageHandler } from './context.js';
import type { PipelineDeps } from './pipeline.js';
import type { DiarizationSegment } from '../speakers/sample-extractor.js';

function testContext(meetings: MeetingsRepo, speakers: SpeakersRepo, libraryRoot: string): PipelineContext {
  return {
    meetings, speakers, libraryRoot, artifactCache: new ArtifactCache(),
    logger: { info: () => {}, error: () => {} },
  } as unknown as PipelineContext;
}

function writeDiarization(root: string, slug: string, segments: DiarizationSegment[]): string {
  const folder = meetingFolderPath(root, slug);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'diarization.json'), JSON.stringify({ segments }));
  return folder;
}

describe('Pipeline', () => {
  it('advances a meeting through all stages, running transcribe + diarize in parallel', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-pl-'));
    const db = openDb(path.join(dir, 'db.sqlite'));
    const meetings = new MeetingsRepo(db);
    meetings.insert({ id: 'm', slug: 's', title: 't', startedAt: null, durationS: null,
      audioPath: '/x.mp3', status: 'processing', pipelineStage: 'discovered' });
    // Bypass the speaker-ID gate for the "runs end-to-end" happy path — that
    // gate is exercised by its own test below.
    meetings.updateSkipSpeakerId('m', true);

    const calls: string[] = [];
    const mk = (name: string) => async () => { calls.push(name); };
    const p = new Pipeline({
      ctx: testContext(meetings, new SpeakersRepo(db), dir),
      stages: {
        transcribing: mk('t'), diarizing: mk('d'), merging: mk('m'),
        identifying: mk('i'), summarizing: mk('s'), extracting: mk('e'),
      },
    });
    const stageEvents: string[] = [];
    p.onMeetingStageChange((id) => {
      stageEvents.push(meetings.findById(id)?.pipelineStage ?? 'missing');
    });
    await p.run('m');
    expect(meetings.findById('m')?.pipelineStage).toBe('done');
    expect(calls).toContain('t'); expect(calls).toContain('d'); expect(calls).toContain('m');
    expect(stageEvents).toContain('transcribing');
    expect(stageEvents).toContain('summarizing');
    expect(stageEvents.at(-1)).toBe('done');
  });

  it('re-running from "transcribing" re-runs both parallel branches', async () => {
    // Treating transcribing/diarizing as a single parallel block means a
    // crash or rerun mid-block always replays both — we never end up with
    // a transcript and no diarization (or vice versa).
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-pl2-'));
    const db = openDb(path.join(dir, 'db.sqlite'));
    const meetings = new MeetingsRepo(db);
    meetings.insert({ id: 'm', slug: 's', title: 't', startedAt: null, durationS: null,
      audioPath: '/x.mp3', status: 'processing', pipelineStage: 'transcribing' });
    meetings.updateSkipSpeakerId('m', true);

    const calls: string[] = [];
    const mk = (name: string) => async () => { calls.push(name); };
    const p = new Pipeline({
      ctx: testContext(meetings, new SpeakersRepo(db), dir),
      stages: {
        transcribing: mk('t'), diarizing: mk('d'), merging: mk('m'),
        identifying: mk('i'), summarizing: mk('s'), extracting: mk('e'),
      },
    });
    await p.run('m');
    expect(calls).toContain('t');
    expect(calls).toContain('d');
    expect(calls).toContain('m');
    expect(meetings.findById('m')?.pipelineStage).toBe('done');
  });

  it('stops at awaiting_speaker_id when skip flag is false, resumes when set', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-pl-gate-'));
    const db = openDb(path.join(dir, 'db.sqlite'));
    const meetings = new MeetingsRepo(db);
    const speakers = new SpeakersRepo(db);
    meetings.insert({ id: 'm', slug: 's', title: 't', startedAt: null, durationS: null,
      audioPath: '/x.mp3', status: 'processing', pipelineStage: 'discovered' });
    // One voice the matcher could not link — the reason the gate exists.
    speakers.linkToMeeting('m', 'SPEAKER_00', null, 0);

    const calls: string[] = [];
    const mk = (name: string) => async () => { calls.push(name); };
    const p = new Pipeline({
      ctx: testContext(meetings, speakers, dir),
      stages: {
        transcribing: mk('t'), diarizing: mk('d'), merging: mk('m'),
        identifying: mk('i'), summarizing: mk('s'), extracting: mk('e'),
      },
    });
    await p.run('m');
    // First pass: identify ran, summarize did NOT — pipeline parked at gate.
    expect(calls).toContain('i');
    expect(calls).not.toContain('s');
    const parked = meetings.findById('m')!;
    expect(parked.pipelineStage).toBe('awaiting_speaker_id');
    expect(parked.status).toBe('awaiting_user');

    // User flips skip flag (or identifies speakers + clicks Continue — same
    // effect: re-enqueue). Second pass should sail past the gate to done.
    meetings.updateSkipSpeakerId('m', true);
    await p.run('m');
    expect(calls).toContain('s');
    expect(calls).toContain('e');
    expect(meetings.findById('m')?.pipelineStage).toBe('done');
  });

  it('fires onAwaitingSpeakerId exactly once when a meeting parks at the gate', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-gate-fire-'));
    const db = openDb(path.join(dir, 'db.sqlite'));
    const meetings = new MeetingsRepo(db);
    const speakers = new SpeakersRepo(db);
    // skipSpeakerId defaults false — this meeting reaches and parks at the gate.
    meetings.insert({ id: 'm1', slug: 'm1', title: 't', startedAt: null, durationS: null,
      audioPath: '/x.mp3', status: 'processing', pipelineStage: 'discovered' });
    speakers.linkToMeeting('m1', 'SPEAKER_00', null, 0);

    const mk = () => async () => {};
    const pipeline = new Pipeline({
      ctx: testContext(meetings, speakers, dir),
      stages: {
        transcribing: mk(), diarizing: mk(), merging: mk(),
        identifying: mk(), summarizing: mk(), extracting: mk(),
      },
    });
    const gateSpy = vi.fn();
    pipeline.onAwaitingSpeakerId(gateSpy);
    await pipeline.run('m1');
    expect(gateSpy).toHaveBeenCalledTimes(1);
    expect(gateSpy).toHaveBeenCalledWith('m1');
    // Parked at the gate, not run to done.
    expect(meetings.findById('m1')!.status).toBe('awaiting_user');
  });

  it('sails past the gate when every voice meets the UI review policy, re-merging names before summary', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-gate-matched-'));
    const db = openDb(path.join(dir, 'db.sqlite'));
    const meetings = new MeetingsRepo(db);
    const speakers = new SpeakersRepo(db);
    meetings.insert({ id: 'm3', slug: 'm3', title: 't', startedAt: null, durationS: null,
      audioPath: '/x.mp3', status: 'processing', pipelineStage: 'discovered' });
    const aliceId = speakers.create({ displayName: 'Alice' });
    const bobId = speakers.create({ displayName: 'Bob' });
    // Exactly 80% is sufficient when supported by at least two segments.
    speakers.linkToMeeting('m3', 'SPEAKER_00', aliceId, 0.8);
    speakers.linkToMeeting('m3', 'SPEAKER_01', bobId, 0.88);
    const folder = writeDiarization(dir, 'm3', [
      { speaker: 'SPEAKER_00', start: 0, end: 2 },
      { speaker: 'SPEAKER_00', start: 2, end: 4 },
      { speaker: 'SPEAKER_01', start: 4, end: 6 },
      { speaker: 'SPEAKER_01', start: 6, end: 8 },
    ]);
    fs.writeFileSync(path.join(folder, 'transcript.raw.json'), JSON.stringify({ segments: [
      { start: 0, end: 2, text: 'Send the report.' },
      { start: 4, end: 6, text: 'I will review it.' },
    ] }));

    const calls: string[] = [];
    const mk = (name: string) => async () => { calls.push(name); };
    const ctx = testContext(meetings, speakers, dir);
    const pipeline = new Pipeline({
      ctx,
      stages: {
        transcribing: mk('t'), diarizing: mk('d'),
        merging: async () => {
          calls.push('m');
          remergeTranscript('m3', ctx);
        },
        identifying: mk('i'),
        summarizing: async () => {
          calls.push('s');
          const transcript = fs.readFileSync(path.join(folder, 'transcript.md'), 'utf8');
          expect(transcript).toContain('Alice');
          expect(transcript).toContain('Bob');
          expect(transcript).not.toContain('SPEAKER_');
        },
        extracting: mk('e'),
      },
    });
    const gateSpy = vi.fn();
    pipeline.onAwaitingSpeakerId(gateSpy);
    await pipeline.run('m3');
    expect(gateSpy).not.toHaveBeenCalled();
    // merging runs twice: once as a stage, once re-merging real names on gate exit.
    expect(calls.filter((c) => c === 'm')).toHaveLength(2);
    expect(calls.slice(-3)).toEqual(['m', 's', 'e']);
    expect(meetings.findById('m3')!.pipelineStage).toBe('done');
  });

  it.each([
    { name: '75% linked match', confidence: 0.75, segments: 2, linked: true },
    { name: '78% linked match', confidence: 0.78, segments: 2, linked: true },
    { name: 'just below 80%', confidence: 0.799, segments: 2, linked: true },
    { name: 'confident match with only one segment', confidence: 0.92, segments: 1, linked: true },
    { name: 'confirmed voice with only one segment', confidence: 1, segments: 1, linked: true },
    { name: 'linked voice without diarization evidence', confidence: 0.92, segments: 0, linked: true },
    { name: 'unknown voice alongside a clear match', confidence: 0, segments: 2, linked: false },
  ])('parks when the UI needs review: $name', async ({ confidence, segments, linked }) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-gate-review-'));
    const db = openDb(path.join(dir, 'db.sqlite'));
    const meetings = new MeetingsRepo(db);
    const speakers = new SpeakersRepo(db);
    meetings.insert({ id: 'review', slug: 'review', title: 't', startedAt: null, durationS: null,
      audioPath: '/x.mp3', status: 'processing', pipelineStage: 'discovered' });
    const rosterId = speakers.create({ displayName: 'Alice' });
    speakers.linkToMeeting('review', 'SPEAKER_00', linked ? rosterId : null, confidence);
    speakers.linkToMeeting('review', 'SPEAKER_01', rosterId, 0.95);
    writeDiarization(dir, 'review', [
      ...Array.from({ length: segments }, (_, i) => ({ speaker: 'SPEAKER_00', start: i, end: i + 1 })),
      { speaker: 'SPEAKER_01', start: 3, end: 4 },
      { speaker: 'SPEAKER_01', start: 4, end: 5 },
    ]);
    const summarizing = vi.fn(async () => {});
    const extracting = vi.fn(async () => {});
    const noop = async () => {};
    const pipeline = new Pipeline({
      ctx: testContext(meetings, speakers, dir),
      stages: { transcribing: noop, diarizing: noop, merging: noop, identifying: noop, summarizing, extracting },
    });
    const gate = vi.fn();
    pipeline.onAwaitingSpeakerId(gate);
    await pipeline.run('review');
    expect(gate).toHaveBeenCalledTimes(1);
    expect(meetings.findById('review')).toMatchObject({ status: 'awaiting_user', pipelineStage: 'awaiting_speaker_id' });
    expect(summarizing).not.toHaveBeenCalled();
    expect(extracting).not.toHaveBeenCalled();
  });

  it('sails past the gate when no voices were detected at all', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-gate-zero-'));
    const db = openDb(path.join(dir, 'db.sqlite'));
    const meetings = new MeetingsRepo(db);
    const speakers = new SpeakersRepo(db);
    meetings.insert({ id: 'm4', slug: 'm4', title: 't', startedAt: null, durationS: null,
      audioPath: '/x.mp3', status: 'processing', pipelineStage: 'discovered' });

    const mk = () => async () => {};
    const pipeline = new Pipeline({
      ctx: testContext(meetings, speakers, dir),
      stages: {
        transcribing: mk(), diarizing: mk(), merging: mk(),
        identifying: mk(), summarizing: mk(), extracting: mk(),
      },
    });
    const gateSpy = vi.fn();
    pipeline.onAwaitingSpeakerId(gateSpy);
    await pipeline.run('m4');
    expect(gateSpy).not.toHaveBeenCalled();
    expect(meetings.findById('m4')!.pipelineStage).toBe('done');
  });

  it('does NOT fire onAwaitingSpeakerId when skipSpeakerId is set', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-gate-skip-'));
    const db = openDb(path.join(dir, 'db.sqlite'));
    const meetings = new MeetingsRepo(db);
    const speakers = new SpeakersRepo(db);
    meetings.insert({ id: 'm2', slug: 'm2', title: 't', startedAt: null, durationS: null,
      audioPath: '/x.mp3', status: 'processing', pipelineStage: 'discovered' });
    meetings.updateSkipSpeakerId('m2', true);
    speakers.linkToMeeting('m2', 'SPEAKER_00', null, 0);
    const ctx = testContext(meetings, speakers, dir);
    const artifactRead = vi.spyOn(ctx.artifactCache, 'readJson');

    const mk = () => async () => {};
    const pipeline = new Pipeline({
      ctx,
      stages: {
        transcribing: mk(), diarizing: mk(), merging: mk(),
        identifying: mk(), summarizing: mk(), extracting: mk(),
      },
    });
    const gateSpy = vi.fn();
    pipeline.onAwaitingSpeakerId(gateSpy);
    await pipeline.run('m2');
    expect(gateSpy).not.toHaveBeenCalled();
    expect(artifactRead).not.toHaveBeenCalled();
  });

  it('keeps linked voices at the gate when their diarization artifact is missing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-gate-missing-'));
    const db = openDb(path.join(dir, 'db.sqlite'));
    const meetings = new MeetingsRepo(db);
    const speakers = new SpeakersRepo(db);
    meetings.insert({ id: 'missing', slug: 'missing', title: 't', startedAt: null, durationS: null,
      audioPath: '/x.mp3', status: 'processing', pipelineStage: 'identifying' });
    speakers.linkToMeeting('missing', 'SPEAKER_00', speakers.create({ displayName: 'Alice' }), 0.95);
    const noop = async () => {};
    const summarizing = vi.fn(noop);
    const pipeline = new Pipeline({
      ctx: testContext(meetings, speakers, dir),
      stages: { transcribing: noop, diarizing: noop, merging: noop, identifying: noop, summarizing, extracting: noop },
    });
    await pipeline.run('missing');
    expect(meetings.findById('missing')!.status).toBe('awaiting_user');
    expect(summarizing).not.toHaveBeenCalled();
  });

  it('honors Skip speaker ID selected while review evidence is loading', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-gate-override-'));
    const db = openDb(path.join(dir, 'db.sqlite'));
    const meetings = new MeetingsRepo(db);
    const speakers = new SpeakersRepo(db);
    meetings.insert({ id: 'override', slug: 'override', title: 't', startedAt: null, durationS: null,
      audioPath: '/x.mp3', status: 'processing', pipelineStage: 'identifying' });
    speakers.linkToMeeting('override', 'SPEAKER_00', null, 0);
    const ctx = testContext(meetings, speakers, dir);
    ctx.artifactCache = new ArtifactCache({
      stat: async () => ({ size: 1, mtimeMs: 1, ctimeMs: 1 }),
      readFile: async () => {
        meetings.updateSkipSpeakerId('override', true);
        return JSON.stringify({ segments: [{ speaker: 'SPEAKER_00', start: 0, end: 1 }] });
      },
    });
    const noop = async () => {};
    const pipeline = new Pipeline({
      ctx,
      stages: { transcribing: noop, diarizing: noop, merging: noop, identifying: noop, summarizing: noop, extracting: noop },
    });
    const gate = vi.fn();
    pipeline.onAwaitingSpeakerId(gate);
    await pipeline.run('override');
    expect(gate).not.toHaveBeenCalled();
    expect(meetings.findById('override')!.pipelineStage).toBe('done');
  });

  it('marks status=failed when a stage throws and rolls back parallel stage', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-pl3-'));
    const db = openDb(path.join(dir, 'db.sqlite'));
    const meetings = new MeetingsRepo(db);
    meetings.insert({ id: 'm', slug: 's', title: 't', startedAt: null, durationS: null,
      audioPath: '/x.mp3', status: 'processing', pipelineStage: 'discovered' });

    const boom = async () => { throw new Error('boom'); };
    const noop = async () => {};
    const p = new Pipeline({
      ctx: testContext(meetings, new SpeakersRepo(db), dir),
      stages: {
        transcribing: noop, diarizing: boom, merging: noop,
        identifying: noop, summarizing: noop, extracting: noop,
      },
    });
    p.enqueue('m');
    // Allow the queue tick to run.
    await new Promise((r) => setTimeout(r, 20));
    const m = meetings.findById('m')!;
    expect(m.status).toBe('failed');
    expect(m.pipelineStage).toBe('discovered');
  });

  describe('stage timing (learned ETA)', () => {
    function timingDeps(summarizing: StageHandler) {
      const recorded: Array<{ stage: string; bucket: number; ms: number }> = [];
      const ctx = {
        libraryRoot: '/nowhere',
        meetings: {
          findById: () => ({ id: 'm', slug: 's', pipelineStage: 'summarizing', status: 'processing' }),
          updateStage: () => {},
          updateStatus: () => {},
        },
        stageDurations: {
          record: (stage: string, bucket: number, ms: number) => recorded.push({ stage, bucket, ms }),
          recentSamples: () => [],
        },
        logger: { error: () => {}, info: () => {} },
      } as unknown as PipelineContext;
      const noop: StageHandler = async () => {};
      const deps: PipelineDeps = {
        ctx,
        stages: {
          transcribing: noop, diarizing: noop, merging: noop, identifying: noop,
          summarizing, extracting: noop,
        },
      };
      return { deps, recorded };
    }

    it('records a positive duration sample for a stage that completes', async () => {
      const { deps, recorded } = timingDeps(async () => {});
      const pipeline = new Pipeline(deps);
      await pipeline.run('m');
      // transcript.md is absent at /nowhere → bucket 0. summarizing must be recorded.
      const s = recorded.find((r) => r.stage === 'summarizing');
      expect(s).toBeDefined();
      expect(s!.bucket).toBe(0);
      expect(s!.ms).toBeGreaterThanOrEqual(0);
    });

    it('records nothing for a stage that throws', async () => {
      const { deps, recorded } = timingDeps(async () => { throw new Error('boom'); });
      const pipeline = new Pipeline(deps);
      await expect(pipeline.run('m')).rejects.toThrow();
      expect(recorded.find((r) => r.stage === 'summarizing')).toBeUndefined();
    });
  });
});
