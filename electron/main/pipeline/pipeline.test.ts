import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../storage/db.js';
import { MeetingsRepo } from '../storage/meetings-repo.js';
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
      ctx: { meetings, logger: { info: () => {}, error: () => {} } } as any,
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
      ctx: { meetings, logger: { info: () => {}, error: () => {} } } as any,
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
    meetings.insert({ id: 'm', slug: 's', title: 't', startedAt: null, durationS: null,
      audioPath: '/x.mp3', status: 'processing', pipelineStage: 'discovered' });

    const calls: string[] = [];
    const mk = (name: string) => async () => { calls.push(name); };
    const p = new Pipeline({
      ctx: { meetings, logger: { info: () => {}, error: () => {} } } as any,
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

  it('marks status=failed when a stage throws and rolls back parallel stage', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-pl3-'));
    const db = openDb(path.join(dir, 'db.sqlite'));
    const meetings = new MeetingsRepo(db);
    meetings.insert({ id: 'm', slug: 's', title: 't', startedAt: null, durationS: null,
      audioPath: '/x.mp3', status: 'processing', pipelineStage: 'discovered' });

    const boom = async () => { throw new Error('boom'); };
    const noop = async () => {};
    const p = new Pipeline({
      ctx: { meetings, logger: { info: () => {}, error: () => {} } } as any,
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
