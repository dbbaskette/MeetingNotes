import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../storage/db.js';
import { runMigrations } from '../storage/migrations.js';
import { MeetingsRepo } from '../storage/meetings-repo.js';
import { ActionItemsRepo } from '../storage/action-items-repo.js';
import { SpeakersRepo } from '../storage/speakers-repo.js';
import { SettingsRepo } from '../storage/settings-repo.js';
import { WeeklySummariesRepo } from '../storage/weekly-summaries-repo.js';
import { WeeklyAggregator } from './aggregator.js';
import { renderWeeklyMarkdown } from './markdown.js';
function setup(persistent = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-week-fresh-')),
    db = openDb(persistent ? path.join(root, 'db.sqlite') : ':memory:');
  const meetings = new MeetingsRepo(db),
    actionItems = new ActionItemsRepo(db),
    speakers = new SpeakersRepo(db);
  const settings = new SettingsRepo(db),
    weeklySummaries = new WeeklySummariesRepo(db);
  meetings.insert({
    id: 'm',
    slug: 'm',
    title: 'Fixture',
    startedAt: '2026-04-22T12:00:00Z',
    durationS: 60,
    audioPath: '/fixture.m4a',
    status: 'done',
    pipelineStage: 'done',
  });
  const folder = path.join(root, 'meetings', 'm');
  fs.mkdirSync(folder, { recursive: true });
  const summary = path.join(folder, 'summary.md');
  fs.writeFileSync(summary, 'Original');
  const generate = vi.fn(async () => ({
    narrative: 'Fixture narrative',
    decisions: [],
    themes: [],
  }));
  const agg = new WeeklyAggregator({
    meetings,
    actionItems,
    speakers,
    settings,
    weeklySummaries,
    libraryRoot: root,
    generateNarrative: generate,
  });
  return {
    db, root, meetings, settings,
    agg,
    generate,
    summary,
    actionItems,
    speakers,
    weeklySummaries,
    cleanup: () => {
      if (db.open) db.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
describe('Weekly input ownership', () => {
  it('preserves the whole saved report and export through source/task/roster changes and a new week', async () => {
    const s = setup();
    try {
      const owner = s.speakers.create({ displayName: 'Priya' });
      const item = s.actionItems.create('m', { text: 'Task' });
      s.db.prepare('UPDATE action_items SET owner_speaker_id = ? WHERE id = ?').run(owner, item.id);
      const original = await s.agg.getWeek(2026, 17);
      const markdown = renderWeeklyMarkdown(original);
      fs.writeFileSync(s.summary, 'Corrected');
      s.actionItems.setStatus(item.id, 'done');
      s.speakers.rename(owner, 'Renamed');
      s.speakers.create({ displayName: 'New week speaker' });
      s.settings.set('userSpeakerId', owner);
      s.meetings.insert({ id: 'next', slug: 'next', title: 'Next week', startedAt: '2026-04-29T12:00:00Z', audioPath: '/next.m4a', durationS: 60, status: 'done', pipelineStage: 'done' });
      await s.agg.getWeek(2026, 18);
      const saved = await s.agg.getWeek(2026, 17);
      expect(saved).toEqual(original);
      expect(renderWeeklyMarkdown(saved)).toBe(markdown);
      expect((await s.agg.getStructuredWeek(2026, 17)).hasFreshCache).toBe(true);
      expect(s.generate).toHaveBeenCalledTimes(2); // one per week, never invalidated
      const regenerated = await s.agg.regenerateWeek(2026, 17);
      expect(regenerated.openActionCount).toBe(0);
      expect(regenerated.meetings[0]!.highlight).toBe('Corrected');
      expect(s.generate).toHaveBeenCalledTimes(3);
    } finally {
      s.cleanup();
    }
  });
  it('reads a disk-backed snapshot after restart, a year boundary and source deletion without an LLM', async () => {
    const s = setup(true);
    try {
      s.actionItems.create('m', { text: 'Saved action' });
      const saved = await s.agg.getWeek(2026, 17);
      // A saved report is independent of source files and live rows.
      s.db.prepare('DELETE FROM action_items').run();
      s.db.prepare('DELETE FROM meetings').run();
      fs.rmSync(path.dirname(s.summary), { recursive: true });
      s.db.close();
      const db = openDb(path.join(s.root, 'db.sqlite'));
      try {
        const generate = vi.fn(async () => { throw new Error('Model offline'); });
        const restarted = new WeeklyAggregator({
          meetings: new MeetingsRepo(db), actionItems: new ActionItemsRepo(db),
          speakers: new SpeakersRepo(db), settings: new SettingsRepo(db),
          weeklySummaries: new WeeklySummariesRepo(db), libraryRoot: s.root, generateNarrative: generate,
        });
        vi.useFakeTimers(); vi.setSystemTime(new Date('2027-01-12T12:00:00Z'));
        expect(await restarted.getWeek(2026, 17)).toEqual(saved);
        expect(renderWeeklyMarkdown(await restarted.getWeek(2026, 17))).toBe(renderWeeklyMarkdown(saved));
        expect(generate).not.toHaveBeenCalled();
        await expect(restarted.regenerateWeek(2026, 17)).rejects.toThrow('saved report has been kept');
        expect(await restarted.getWeek(2026, 17)).toEqual(saved);
      } finally { vi.useRealTimers(); db.close(); }
    } finally { s.cleanup(); }
  });
  it('upgrades a legacy cached narrative without regenerating or changing its timestamp', async () => {
    const s = setup();
    try {
      s.weeklySummaries.upsert({ isoYear: 2026, isoWeek: 17, narrative: 'Legacy overview',
        themes: [{ title: 'Saved theme', detail: 'Original', meetings: ['Fixture'] }],
        decisions: ['Original decision'], inputHash: 'obsolete hash' });
      // Recreate the prior schema, then exercise the real upgrade twice.
      s.db.exec('ALTER TABLE weekly_summaries DROP COLUMN snapshot_json');
      s.db.prepare('UPDATE schema_version SET version = 23').run();
      runMigrations(s.db); runMigrations(s.db);
      const date = s.weeklySummaries.get(2026, 17)!.generatedAt;
      const saved = await s.agg.getWeek(2026, 17);
      expect(saved.narrative).toBe('Legacy overview');
      expect(saved.generatedAt).toBe(date);
      expect(saved.legacySnapshot).toBe(true);
      expect(saved.themes[0]!.title).toBe('Saved theme');
      fs.writeFileSync(s.summary, 'Later');
      expect(await s.agg.getWeek(2026, 17)).toEqual(saved);
      expect(s.generate).not.toHaveBeenCalled();
    } finally { s.cleanup(); }
  });
  it('keeps the previous report available while regeneration is pending or fails', async () => {
    const s = setup();
    try {
      const saved = await s.agg.getWeek(2026, 17);
      let reject!: (error: Error) => void;
      s.generate.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
      const replacing = s.agg.regenerateWeek(2026, 17);
      const failed = expect(replacing).rejects.toThrow('Model offline');
      expect(await s.agg.getWeek(2026, 17)).toEqual(saved);
      reject(new Error('Model offline'));
      await failed;
      expect(await s.agg.getWeek(2026, 17)).toEqual(saved);
      expect(s.generate).toHaveBeenCalledTimes(2);
    } finally { s.cleanup(); }
  });
  it('ignores unrelated speaker additions during generation, but guards relevant owner changes', async () => {
    const s = setup();
    try {
      const owner = s.speakers.create({ displayName: 'Owner' });
      const item = s.actionItems.create('m', { text: 'Task' });
      s.db.prepare('UPDATE action_items SET owner_speaker_id = ? WHERE id = ?').run(owner, item.id);
      let finish!: () => void;
      const deferred = () => new Promise<{ narrative: string; themes: []; decisions: [] }>(resolve => {
        finish = () => resolve({ narrative: 'Saved', themes: [], decisions: [] });
      });
      s.generate.mockImplementationOnce(deferred);
      const first = s.agg.getWeek(2026, 17);
      s.speakers.create({ displayName: 'Unrelated' }); finish();
      const saved = await first;
      s.generate.mockImplementationOnce(deferred);
      const replacing = s.agg.regenerateWeek(2026, 17);
      const failed = expect(replacing).rejects.toThrow('week changed');
      s.speakers.rename(owner, 'Changed owner'); finish(); await failed;
      expect(await s.agg.getWeek(2026, 17)).toEqual(saved);
    } finally { s.cleanup(); }
  });
  it('coalesces normal/force and rejects a result after its source changes', async () => {
    const s = setup();
    try {
      let finish!: () => void;
      s.generate.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = () => resolve({ narrative: 'Old', themes: [], decisions: [] });
          }),
      );
      const a = s.agg.getOrGenerateNarrative(2026, 17),
        b = s.agg.getOrGenerateNarrative(2026, 17, { force: true });
      expect(s.generate).toHaveBeenCalledOnce();
      fs.writeFileSync(s.summary, 'Changed during generation');
      finish();
      await expect(a).rejects.toThrow('week changed');
      await expect(b).rejects.toThrow('week changed');
      expect(s.weeklySummaries.get(2026, 17)).toBeNull();
      await s.agg.getOrGenerateNarrative(2026, 17);
      expect(s.generate).toHaveBeenCalledTimes(2);
    } finally {
      s.cleanup();
    }
  });
});
