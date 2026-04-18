import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../storage/db.js';
import { MeetingsRepo } from '../storage/meetings-repo.js';
import { Pipeline } from './pipeline.js';

describe('Pipeline', () => {
  it('advances a meeting through all stages, running transcribe + diarize in parallel', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-pl-'));
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
});
