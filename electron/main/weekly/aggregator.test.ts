// electron/main/weekly/aggregator.test.ts
//
// Tests the cache-or-regenerate flow + action item grouping. Uses a
// real in-memory SQLite (better-sqlite3 ":memory:") so the repo
// queries are exercised end-to-end, not stubbed. The LLM call is
// stubbed via the AggregatorDeps.generateNarrative seam.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runMigrations } from '../storage/migrations.js';
import { MeetingsRepo } from '../storage/meetings-repo.js';
import { ActionItemsRepo } from '../storage/action-items-repo.js';
import { SpeakersRepo } from '../storage/speakers-repo.js';
import { SettingsRepo } from '../storage/settings-repo.js';
import { WeeklySummariesRepo } from '../storage/weekly-summaries-repo.js';
import { WeeklyAggregator } from './aggregator.js';

function setupDb(): { db: Database.Database; meetings: MeetingsRepo; actionItems: ActionItemsRepo; speakers: SpeakersRepo; settings: SettingsRepo; weekly: WeeklySummariesRepo } {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return {
    db,
    meetings: new MeetingsRepo(db),
    actionItems: new ActionItemsRepo(db),
    speakers: new SpeakersRepo(db),
    settings: new SettingsRepo(db),
    weekly: new WeeklySummariesRepo(db),
  };
}

function setupLib(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mn-week-'));
}

function insertMeeting(meetings: MeetingsRepo, db: Database.Database, opts: {
  id: string; title: string; startedAt: string; slug?: string;
  durationS?: number;
}): void {
  meetings.insert({
    id: opts.id,
    slug: opts.slug ?? opts.id,
    title: opts.title,
    startedAt: opts.startedAt,
    durationS: opts.durationS ?? 1800,
    audioPath: `/tmp/${opts.id}.m4a`,
    status: 'done',
    pipelineStage: 'done',
  });
}

describe('WeeklyAggregator', () => {
  let lib: string;
  beforeEach(() => {
    lib = setupLib();
  });

  it('returns empty data with no LLM call when the week has no meetings', async () => {
    const { meetings, actionItems, speakers, settings, weekly } = setupDb();
    const generate = vi.fn(async () => ({ narrative: 'unused', themes: [], decisions: [] }));
    const agg = new WeeklyAggregator({
      meetings, actionItems, speakers, settings, weeklySummaries: weekly,
      libraryRoot: lib, generateNarrative: generate,
    });
    const data = await agg.getWeek(2026, 17);
    expect(data.meetings).toEqual([]);
    expect(data.openActionGroups).toEqual([]);
    expect(data.openActionCount).toBe(0);
    expect(data.narrative).toBe('');
    expect(generate).not.toHaveBeenCalled();
  });

  it('generates + caches narrative on first call, reuses cache on second', async () => {
    const { meetings, actionItems, speakers, settings, weekly } = setupDb();
    insertMeeting(meetings, undefined as never, {
      id: 'm1', title: 'Q2 planning', startedAt: '2026-04-20T10:00:00.000Z',
    });
    const generate = vi.fn(async () => ({
      narrative: 'Focus was Q2.',
      themes: [{ title: 'Q2 OKRs', detail: 'Set the quarter goals.', meetings: ['Q2 planning'] }],
      decisions: ['Locked OKRs — Q2 planning'],
    }));
    const agg = new WeeklyAggregator({
      meetings, actionItems, speakers, settings, weeklySummaries: weekly,
      libraryRoot: lib, generateNarrative: generate,
    });
    const first = await agg.getWeek(2026, 17);
    expect(first.narrative).toBe('Focus was Q2.');
    expect(first.decisions).toEqual(['Locked OKRs — Q2 planning']);
    expect(generate).toHaveBeenCalledTimes(1);

    const second = await agg.getWeek(2026, 17);
    expect(second.narrative).toBe('Focus was Q2.');
    expect(generate).toHaveBeenCalledTimes(1); // cache hit
  });

  it('regenerates when input hash changes (new meeting added)', async () => {
    const { meetings, actionItems, speakers, settings, weekly } = setupDb();
    insertMeeting(meetings, undefined as never, {
      id: 'm1', title: 'Q2 planning', startedAt: '2026-04-20T10:00:00.000Z',
    });
    let callCount = 0;
    const generate = vi.fn(async () => {
      callCount += 1;
      return {
        narrative: callCount === 1 ? 'first' : 'second',
        themes: [],
        decisions: [],
      };
    });
    const agg = new WeeklyAggregator({
      meetings, actionItems, speakers, settings, weeklySummaries: weekly,
      libraryRoot: lib, generateNarrative: generate,
    });
    const first = await agg.getWeek(2026, 17);
    expect(first.narrative).toBe('first');

    // Add a second meeting in the same week. Hash changes → regenerate.
    insertMeeting(meetings, undefined as never, {
      id: 'm2', title: 'Vendor sync', startedAt: '2026-04-22T14:00:00.000Z',
    });
    const second = await agg.getWeek(2026, 17);
    expect(second.narrative).toBe('second');
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it('forces regeneration on regenerateWeek even if hash unchanged', async () => {
    const { meetings, actionItems, speakers, settings, weekly } = setupDb();
    insertMeeting(meetings, undefined as never, {
      id: 'm1', title: 'Q2 planning', startedAt: '2026-04-20T10:00:00.000Z',
    });
    const generate = vi.fn(async () => ({ narrative: 'paragraph', themes: [], decisions: [] }));
    const agg = new WeeklyAggregator({
      meetings, actionItems, speakers, settings, weeklySummaries: weekly,
      libraryRoot: lib, generateNarrative: generate,
    });
    await agg.getWeek(2026, 17);
    expect(generate).toHaveBeenCalledTimes(1);
    await agg.regenerateWeek(2026, 17);
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it('skips narrative generation for the in-progress (current) week', async () => {
    const { meetings, actionItems, speakers, settings, weekly } = setupDb();
    // Meeting in the future — guarantees the resolved week's end is
    // ahead of "now", which is how the aggregator detects in-progress.
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
    insertMeeting(meetings, undefined as never, {
      id: 'm-current',
      title: 'Mid-week sync',
      startedAt: future.toISOString(),
    });
    // Compute the ISO week of `future` the same way the aggregator does.
    const target = new Date(Date.UTC(future.getUTCFullYear(), future.getUTCMonth(), future.getUTCDate()));
    const dow = (target.getUTCDay() + 6) % 7;
    target.setUTCDate(target.getUTCDate() - dow + 3);
    const isoYear = target.getUTCFullYear();
    const jan4 = new Date(Date.UTC(isoYear, 0, 4));
    const jan4Dow = (jan4.getUTCDay() + 6) % 7;
    const week1Thu = new Date(jan4);
    week1Thu.setUTCDate(jan4.getUTCDate() - jan4Dow + 3);
    const isoWeek = 1 + Math.round(
      (target.getTime() - week1Thu.getTime()) / (7 * 24 * 60 * 60 * 1000),
    );

    const generate = vi.fn(async () => ({ narrative: 'should not happen', themes: [], decisions: [] }));
    const agg = new WeeklyAggregator({
      meetings, actionItems, speakers, settings, weeklySummaries: weekly,
      libraryRoot: lib, generateNarrative: generate,
    });
    const data = await agg.getWeek(isoYear, isoWeek);
    expect(data.meetings).toHaveLength(1); // structured rollup still works
    expect(data.narrative).toBe('');       // narrative gated
    expect(data.decisions).toEqual([]);
    expect(generate).not.toHaveBeenCalled();

    // Even force=true (Regenerate button) doesn't override — answer
    // would be obsolete by the time the user reads it.
    await agg.regenerateWeek(isoYear, isoWeek);
    expect(generate).not.toHaveBeenCalled();
  });

  it('generates, caches, and reuses themes across calls', async () => {
    const { meetings, actionItems, speakers, settings, weekly } = setupDb();
    insertMeeting(meetings, undefined as never, {
      id: 'm1', title: 'Q2 planning', startedAt: '2026-04-20T10:00:00.000Z',
    });
    const themes = [
      { title: 'Migration', detail: 'Discussed fixtures and timeline.', meetings: ['Q2 planning'] },
    ];
    const generate = vi.fn(async () => ({ narrative: 'n', themes, decisions: [] }));
    const agg = new WeeklyAggregator({
      meetings, actionItems, speakers, settings, weeklySummaries: weekly,
      libraryRoot: lib, generateNarrative: generate,
    });
    const first = await agg.getWeek(2026, 17);
    expect(first.themes).toEqual(themes);
    // Second call is a cache hit and must return the themes from storage,
    // proving the themes_json round-trip through the repo.
    const second = await agg.getWeek(2026, 17);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(second.themes).toEqual(themes);
  });

  it('uses the summary Overview paragraph as each meeting recap', async () => {
    const { meetings, actionItems, speakers, settings, weekly } = setupDb();
    insertMeeting(meetings, undefined as never, {
      id: 'm1', title: 'Q2 planning', startedAt: '2026-04-20T10:00:00.000Z', slug: 'q2',
    });
    const folder = path.join(lib, 'meetings', 'q2');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(
      path.join(folder, 'summary.md'),
      '## Overview\n\nSet the Q2 OKRs. Agreed to ship the migration in May. Deferred the pricing decision.\n\n## Key Discussion Points\n- x',
    );
    const generate = vi.fn(async () => ({ narrative: 'n', themes: [], decisions: [] }));
    const agg = new WeeklyAggregator({
      meetings, actionItems, speakers, settings, weeklySummaries: weekly,
      libraryRoot: lib, generateNarrative: generate,
    });
    const structured = await agg.getStructuredWeek(2026, 17);
    expect(structured.meetings[0]!.highlight).toBe(
      'Set the Q2 OKRs. Agreed to ship the migration in May. Deferred the pricing decision.',
    );
  });

  it('groups open action items by owner, with the user pinned first', async () => {
    const { meetings, actionItems, speakers, settings, weekly, db } = setupDb();
    insertMeeting(meetings, undefined as never, {
      id: 'm1', title: 'Mtg', startedAt: '2026-04-20T10:00:00.000Z',
    });
    const youId = speakers.create({ displayName: 'You' });
    settings.set('userSpeakerId', youId);

    // Three items: one to "You", one to Alex, one with no owner.
    const insAi = db.prepare(`
      INSERT INTO action_items (id, meeting_id, text, owner_speaker_id, owner_name, due_date, status, exported_to, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, '[]', ?)
    `);
    const now = new Date().toISOString();
    insAi.run('ai1', 'm1', 'Send SOC2', youId, null, '2026-04-25', 'open', now);
    insAi.run('ai2', 'm1', 'Pilot SLA', null, 'Alex', null, 'open', now);
    insAi.run('ai3', 'm1', 'Closed item', null, null, null, 'done', now);
    insAi.run('ai4', 'm1', 'Unowned action', null, null, null, 'open', now);

    const generate = vi.fn(async () => ({ narrative: 'x', themes: [], decisions: [] }));
    const agg = new WeeklyAggregator({
      meetings, actionItems, speakers, settings, weeklySummaries: weekly,
      libraryRoot: lib, generateNarrative: generate,
    });
    const data = await agg.getWeek(2026, 17);
    // 3 open items (excluded the done one).
    expect(data.openActionCount).toBe(3);
    // Groups: You first, then alphabetical (Alex), then Unassigned.
    expect(data.openActionGroups.map((g) => g.ownerLabel)).toEqual(['You', 'Alex', 'Unassigned']);
    expect(data.openActionGroups[0]!.isYou).toBe(true);
    expect(data.openActionGroups[0]!.items[0]!.text).toBe('Send SOC2');
  });
});
