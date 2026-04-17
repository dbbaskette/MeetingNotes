import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../storage/db';
import { MeetingsRepo } from '../storage/meetings-repo';
import { Pipeline } from './pipeline';

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

  it('re-running from "transcribing" runs only transcribe + downstream (no diarize)', async () => {
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
    expect(calls).not.toContain('d');
    expect(calls).toContain('m');
    expect(meetings.findById('m')?.pipelineStage).toBe('done');
  });
});
