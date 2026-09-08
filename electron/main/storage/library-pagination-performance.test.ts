import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from './db.js';
import { MeetingsRepo } from './meetings-repo.js';
import { SpeakersRepo } from './speakers-repo.js';
import { ActionItemsRepo } from './action-items-repo.js';
import { StageDurationsRepo } from './stage-durations-repo.js';
import { MIGRATIONS } from './migrations.js';
import { registerIpcHandlers, type IpcServices } from '../ipc/handlers.js';
import { createPagedMeetings, type MeetingPage } from '../../renderer/src/lib/paged-meetings.js';
import { hydrateAttentionMeetings } from '../../renderer/src/lib/meeting-hydration.js';

const SEED = 210;
const WARM_RUNS = 7;
const FIRST_PAGE = { filter: 'all', sort: 'newest', pageSize: 50 } as const;
type Handler = (event: unknown, input?: unknown) => unknown;
type Timings = Record<string, number>;
interface Sample {
  mode: string; run: number; cache: 'cold-connection' | 'warm'; wallMs: number;
  serializedBytes: number; summaries: number; speakerRows: number; actionRows: number;
  calls: Record<string, number>; timingsMs: Timings;
}

function seed(db: Database.Database, count: number): void {
  let state = SEED;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; };
  const insert = db.prepare(`INSERT INTO meetings
    (id, slug, title, started_at, duration_s, audio_path, status, pipeline_stage, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const speaker = db.prepare('INSERT INTO speakers (id, display_name, created_at) VALUES (?, ?, ?)');
  const link = db.prepare('INSERT INTO meeting_speakers (meeting_id, local_label, roster_speaker_id, confidence) VALUES (?, ?, ?, ?)');
  const action = db.prepare('INSERT INTO action_items (id, meeting_id, text, created_at) VALUES (?, ?, ?, ?)');
  const fixedTime = '2026-09-08T12:00:00.000Z';
  db.transaction(() => {
    for (let i = 0; i < 8; i++) speaker.run(`person-${i}`, `Fixture Person ${i}`, fixedTime);
    for (let i = 0; i < count; i++) {
      const id = `meeting-${String(i).padStart(5, '0')}`;
      // Exact 80% done, 5% each pending/awaiting/processing/failed. Fixed
      // duplicate dates/titles/durations and nulls exercise real sort work.
      const status = ['pending', 'awaiting_user', 'processing', 'failed'][i % 20] ?? 'done';
      const stage = status === 'pending' ? 'discovered' : status === 'awaiting_user' ? 'awaiting_speaker_id'
        : status === 'done' ? 'done' : 'transcribing';
      const date = i % 17 === 0 ? null : new Date(Date.UTC(2026, 0, 1) + (random() % 180) * 86400000).toISOString();
      insert.run(id, id, `Planning ${random() % 100}: decisions and delivery milestones`, date,
        i % 23 === 0 ? null : (random() % 60) * 60, `/synthetic/${id}.m4a`, status, stage, fixedTime, fixedTime);
      for (let n = 0; n < 4; n++) link.run(id, `SPEAKER_0${n}`, n < 2 ? `person-${n}` : null, n < 2 ? 0.95 : null);
      for (let n = 0; n < 3; n++) action.run(`${id}-action-${n}`, id, `Synthetic follow-up ${n}`, fixedTime);
    }
  })();
}

function summarize(samples: Sample[]) {
  const stats = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    return { median: sorted[Math.floor(sorted.length / 2)]!, min: sorted[0]!, max: sorted[sorted.length - 1]! };
  };
  return Object.fromEntries([...new Set(samples.map((sample) => sample.mode))].map((mode) => {
    const rows = samples.filter((sample) => sample.mode === mode && sample.cache === 'warm');
    return [mode, { wallMs: stats(rows.map((row) => row.wallMs)),
      timingsMs: Object.fromEntries([...new Set(rows.flatMap((row) => Object.keys(row.timingsMs)))].map((key) =>
        [key, stats(rows.map((row) => row.timingsMs[key] ?? 0))])),
      serializedBytes: rows[0]!.serializedBytes, summaries: rows[0]!.summaries,
      speakerRows: rows[0]!.speakerRows, actionRows: rows[0]!.actionRows, calls: rows[0]!.calls }];
  }));
}

// No production main/preload, user profile, audio, or network service starts.
// All filesystem probes performed by ETA point inside this mkdtemp fixture.
describe.skipIf(process.env.MN_LIBRARY_BENCH !== '1')('Library pagination benchmark (#210)', () => {
  it.each([1000, 10000])('measures %i fixed-seed meetings, cold connections and seven alternating warm runs', async (count) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-library-bench-'));
    const dbPath = path.join(directory, 'fixture.sqlite');
    let db = openDb(dbPath);
    const samples: Sample[] = [];
    try {
      seed(db, count);
      db.pragma('wal_checkpoint(TRUNCATE)');
      db.close();
      let current: Sample | undefined;
      const makeHandlers = () => {
        const meetings = new MeetingsRepo(db);
        const speakers = new SpeakersRepo(db);
        const actionItems = new ActionItemsRepo(db);
        const wrap = (object: object, method: string, bucket: string, rows?: (result: any) => void) => {
          const methods = object as Record<string, (...args: any[]) => any>;
          const original = methods[method]!.bind(object);
          methods[method] = (...args) => {
            const start = performance.now();
            const result = original(...args);
            if (current) {
              current.timingsMs[bucket] = (current.timingsMs[bucket] ?? 0) + performance.now() - start;
              current.calls[method] = (current.calls[method] ?? 0) + 1;
              rows?.(result);
            }
            return result;
          };
        };
        for (const method of ['listAll', 'listPage', 'findByIds']) wrap(meetings, method, 'query');
        wrap(meetings, 'counts', 'counts');
        wrap(meetings, 'listIds', 'ids');
        for (const method of ['listForAllMeetings', 'listForMeetings']) wrap(speakers, method, 'enrichment',
          (result: Map<string, unknown[]>) => { current!.speakerRows += [...result.values()].reduce((sum, rows) => sum + rows.length, 0); });
        for (const method of ['countsByMeeting', 'countsForMeetings']) wrap(actionItems, method, 'enrichment',
          (result: Map<string, number>) => { current!.actionRows += [...result.values()].reduce((sum, n) => sum + n, 0); });
        const handlers = new Map<string, Handler>();
        registerIpcHandlers({ handle: (channel: string, handler: Handler) => handlers.set(channel, handler) } as never, {
          libraryRoot: directory, meetings, speakers, actionItems, stageDurations: new StageDurationsRepo(db),
        } as unknown as IpcServices);
        return handlers;
      };
      let handlers: ReturnType<typeof makeHandlers>;
      const invoke = (channel: string, input?: unknown) => handlers.get(channel)!(null, input);
      const measure = async (mode: string, run: number, cache: Sample['cache'], operation: () => unknown | Promise<unknown>, serializedInOperation = false) => {
        const sample: Sample = { mode, run, cache, wallMs: 0, serializedBytes: 0, summaries: 0, speakerRows: 0, actionRows: 0, calls: {}, timingsMs: {} };
        current = sample;
        const start = performance.now();
        try {
          const result = await operation();
          if (!serializedInOperation) {
            const serialStart = performance.now();
            sample.serializedBytes = Buffer.byteLength(JSON.stringify(result));
            sample.timingsMs.serialize = performance.now() - serialStart;
            sample.summaries = Array.isArray(result) ? result.length : (result as MeetingPage).items.length;
          }
          sample.wallMs = performance.now() - start;
          samples.push(sample);
          return result;
        } finally { current = undefined; }
      };
      const operations = {
        'old-full-list': () => invoke('meetings:list'),
        'new-first-page': () => invoke('meetings:list-page', FIRST_PAGE),
      };
      for (const [mode, operation] of Object.entries(operations)) {
        db = openDb(dbPath); handlers = makeHandlers();
        await measure(mode, 0, 'cold-connection', operation);
        db.close();
      }
      db = openDb(dbPath); handlers = makeHandlers();
      for (let run = 1; run <= WARM_RUNS; run++) {
        const entries = Object.entries(operations);
        if (run % 2 === 0) entries.reverse();
        for (const [mode, operation] of entries) await measure(mode, run, 'warm', operation);
      }
      // Serialization is charged for every IPC response, including the three
      // global actionable ID lists. No Electron structured-clone timing here.
      const transport = async (channel: string, input?: unknown) => {
        const result = invoke(channel, input);
        const start = performance.now();
        const source = JSON.stringify(result);
        if (current) {
          current.serializedBytes += Buffer.byteLength(source);
          current.timingsMs.serialize = (current.timingsMs.serialize ?? 0) + performance.now() - start;
          current.summaries += Array.isArray(result) ? result.filter((row) => typeof row === 'object').length : (result as MeetingPage).items.length;
        }
        return result as any;
      };
      for (let run = 1; run <= WARM_RUNS; run++) await measure('global-attention', run, 'warm', () => hydrateAttentionMeetings({
        listIds: (filter) => transport('meetings:list-ids', filter), getMany: (ids) => transport('meetings:get-many', ids),
      }), true);
      for (const prefix of [50, 500, 1000]) {
        const store = createPagedMeetings((query) => transport('meetings:list-page', query));
        await store.getState().setQuery(FIRST_PAGE);
        while (store.getState().items.length < prefix) await store.getState().loadMore();
        for (let run = 1; run <= WARM_RUNS; run++) await measure(`refresh-prefix-${prefix}`, run, 'warm', () => store.getState().refresh(), true);
        expect(store.getState().items).toHaveLength(prefix);
      }
      // Isolate migration 16 against precisely the same first-page query.
      // Creation/drop are outside timing; no candidate index touches user DBs.
      const indexMeasurements: Array<{ indexed: boolean; run: number; queryMs: number }> = [];
      const repo = new MeetingsRepo(db);
      const indexSql = MIGRATIONS.find((migration) => migration.version === 16)!.up;
      for (let run = 1; run <= WARM_RUNS; run++) {
        for (const indexed of run % 2 ? [false, true] : [true, false]) {
          db.exec('DROP INDEX IF EXISTS idx_meetings_browse_newest');
          if (indexed) db.exec(indexSql);
          repo.listPage(FIRST_PAGE); // Equal untimed primer after schema change.
          const start = performance.now();
          repo.listPage(FIRST_PAGE);
          indexMeasurements.push({ indexed, run, queryMs: performance.now() - start });
        }
      }
      db.exec(indexSql);
      // Capture the actual SQL and parameters emitted by the repositories.
      const plans: Array<{ sql: string; detail: string[] }> = [];
      const traced = new Proxy(db, { get(target, key) {
        if (key !== 'prepare') return Reflect.get(target, key);
        return (sql: string) => {
          const statement = target.prepare(sql);
          return new Proxy(statement, { get(stmt, method) {
            if (method !== 'all' && method !== 'get') return Reflect.get(stmt, method);
            return (...params: any[]) => {
              plans.push({ sql, detail: (target.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[]).map((row) => row.detail) });
              return stmt[method](...params);
            };
          } });
        };
      } });
      const tracedRepo = new MeetingsRepo(traced);
      tracedRepo.listAll();
      const first = tracedRepo.listPage(FIRST_PAGE);
      tracedRepo.listPage({ ...FIRST_PAGE, cursor: first.nextCursor! });
      tracedRepo.listPage({ ...FIRST_PAGE, sort: 'title' });
      tracedRepo.counts();
      const ids = first.rows.map((row) => row.id);
      new SpeakersRepo(traced).listForMeetings(ids);
      new ActionItemsRepo(traced).countsForMeetings(ids);
      for (const sample of samples) {
        if (sample.mode === 'old-full-list') { expect(sample.summaries).toBe(count); expect(sample.speakerRows).toBe(count * 4); }
        if (sample.mode === 'new-first-page') { expect(sample.summaries).toBe(50); expect(sample.speakerRows).toBe(200); expect(sample.actionRows).toBe(150); }
        if (sample.mode === 'global-attention') expect(sample.summaries).toBe(count / 5);
      }
      console.log('MN_LIBRARY_BENCH_RESULT=' + JSON.stringify({
        environment: { node: process.version, platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model,
          sqlite: db.prepare('SELECT sqlite_version() AS version').get() },
        fixture: { seed: SEED, meetings: count, speakersPerMeeting: 4, actionsPerMeeting: 3, actionableFraction: 0.2, warmRuns: WARM_RUNS },
        summary: summarize(samples), samples, indexMeasurements, plans,
      }, null, 2));
    } finally {
      if (db.open) db.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }, 120_000);
});
