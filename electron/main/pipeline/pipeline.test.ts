import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../storage/db.js';
import { MeetingsRepo } from '../storage/meetings-repo.js';
import { SpeakersRepo } from '../storage/speakers-repo.js';
import { Pipeline } from './pipeline.js';
import type { StageHandler } from './context.js';

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
      ctx: { meetings, speakers: new SpeakersRepo(db), logger: { info: () => {}, error: () => {} } } as any,
      stages: {
        transcribing: mk('t'), diarizing: mk('d'), merging: mk('m'),
        identifying: mk('i'), summarizing: mk('s'), extracting: mk('e'),
      },
    });
    await p.run('m');
    expect(meetings.findById('m')?.pipelineStage).toBe('done');
    expect(calls).toContain('t'); expect(calls).toContain('d'); expect(calls).toContain('m');
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
      ctx: { meetings, speakers: new SpeakersRepo(db), logger: { info: () => {}, error: () => {} } } as any,
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
      ctx: { meetings, speakers, logger: { info: () => {}, error: () => {} } } as any,
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
      ctx: { meetings, speakers, logger: { info: () => {}, error: () => {} } } as any,
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

  it('sails past the gate when every voice matched the roster', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-gate-matched-'));
    const db = openDb(path.join(dir, 'db.sqlite'));
    const meetings = new MeetingsRepo(db);
    const speakers = new SpeakersRepo(db);
    meetings.insert({ id: 'm3', slug: 'm3', title: 't', startedAt: null, durationS: null,
      audioPath: '/x.mp3', status: 'processing', pipelineStage: 'discovered' });
    const aliceId = speakers.create({ displayName: 'Alice' });
    const bobId = speakers.create({ displayName: 'Bob' });
    speakers.linkToMeeting('m3', 'SPEAKER_00', aliceId, 0.92);
    speakers.linkToMeeting('m3', 'SPEAKER_01', bobId, 0.88);

    const calls: string[] = [];
    const mk = (name: string) => async () => { calls.push(name); };
    const pipeline = new Pipeline({
      ctx: { meetings, speakers, logger: { info: () => {}, error: () => {} } } as any,
      stages: {
        transcribing: mk('t'), diarizing: mk('d'), merging: mk('m'),
        identifying: mk('i'), summarizing: mk('s'), extracting: mk('e'),
      },
    });
    const gateSpy = vi.fn();
    pipeline.onAwaitingSpeakerId(gateSpy);
    await pipeline.run('m3');
    expect(gateSpy).not.toHaveBeenCalled();
    // merging runs twice: once as a stage, once re-merging real names on gate exit.
    expect(calls.filter((c) => c === 'm')).toHaveLength(2);
    expect(meetings.findById('m3')!.pipelineStage).toBe('done');
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
      ctx: { meetings, speakers, logger: { info: () => {}, error: () => {} } } as any,
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

    const mk = () => async () => {};
    const pipeline = new Pipeline({
      ctx: { meetings, speakers, logger: { info: () => {}, error: () => {} } } as any,
      stages: {
        transcribing: mk(), diarizing: mk(), merging: mk(),
        identifying: mk(), summarizing: mk(), extracting: mk(),
      },
    });
    const gateSpy = vi.fn();
    pipeline.onAwaitingSpeakerId(gateSpy);
    await pipeline.run('m2');
    expect(gateSpy).not.toHaveBeenCalled();
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
      ctx: { meetings, speakers: new SpeakersRepo(db), logger: { info: () => {}, error: () => {} } } as any,
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
      const ctx: any = {
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
      };
      const noop: StageHandler = async () => {};
      const deps: any = {
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
