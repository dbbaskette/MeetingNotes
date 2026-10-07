import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../storage/db.js';
import { MeetingsRepo } from '../storage/meetings-repo.js';
import { ActionItemsRepo } from '../storage/action-items-repo.js';
import { SpeakersRepo } from '../storage/speakers-repo.js';
import { SettingsRepo } from '../storage/settings-repo.js';
import { WeeklySummariesRepo } from '../storage/weekly-summaries-repo.js';
import { WeeklyAggregator } from './aggregator.js';
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-week-fresh-')),
    db = openDb(':memory:');
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
    agg,
    generate,
    summary,
    actionItems,
    speakers,
    weeklySummaries,
    cleanup: () => {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
describe('Weekly input ownership', () => {
  it('invalidates on summary bytes, task mutations and roster edits without timestamp touches', async () => {
    const s = setup();
    try {
      await s.agg.getOrGenerateNarrative(2026, 17);
      fs.writeFileSync(s.summary, 'Corrected');
      expect((await s.agg.getStructuredWeek(2026, 17)).hasFreshCache).toBe(false);
      await s.agg.getOrGenerateNarrative(2026, 17);
      const item = s.actionItems.create('m', { text: 'Task' });
      expect((await s.agg.getStructuredWeek(2026, 17)).hasFreshCache).toBe(false);
      await s.agg.getOrGenerateNarrative(2026, 17);
      s.actionItems.setStatus(item.id, 'done');
      expect((await s.agg.getStructuredWeek(2026, 17)).hasFreshCache).toBe(false);
      await s.agg.getOrGenerateNarrative(2026, 17);
      s.speakers.create({ displayName: 'Priya' });
      expect((await s.agg.getStructuredWeek(2026, 17)).hasFreshCache).toBe(false);
    } finally {
      s.cleanup();
    }
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
