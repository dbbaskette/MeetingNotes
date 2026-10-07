import type { IpcMain } from 'electron';
import { dialog } from 'electron';
import fs from 'node:fs';
import { IPC_CHANNELS } from './contracts.js';
import type { IpcServices } from './handlers.js';
import type { WeeklyData } from '../weekly/aggregator.js';
import { renderWeeklyMarkdown } from '../weekly/markdown.js';

export function registerWeeklyHandlers(ipc: IpcMain, s: IpcServices): void {
  // Weekly summary (#weekly). Year/week pair identifies an ISO week.
  // The aggregator handles cache-or-regenerate based on input hash.
  const validWeek = (y: unknown, w: unknown): { year: number; week: number } | null => {
    if (typeof y !== 'number' || typeof w !== 'number') return null;
    if (!Number.isInteger(y) || !Number.isInteger(w)) return null;
    if (y < 1970 || y > 9999) return null;
    if (w < 1 || w > 53) return null;
    return { year: y, week: w };
  };

  ipc.handle(IPC_CHANNELS.weeklyGet, async (_e, year: unknown, week: unknown): Promise<WeeklyData> => {
    const w = validWeek(year, week);
    if (!w) throw new Error('invalid year/week');
    return s.weeklyAggregator.getWeek(w.year, w.week);
  });

  // Fast path: structured data only (meetings + actions + decisions
  // groups), no LLM call. Used by the WeeklyView's parallel-fetch
  // pattern so the page paints immediately while the narrative is
  // still being drafted.
  ipc.handle(IPC_CHANNELS.weeklyGetStructured, async (_e, year: unknown, week: unknown) => {
    const w = validWeek(year, week);
    if (!w) throw new Error('invalid year/week');
    return s.weeklyAggregator.getStructuredWeek(w.year, w.week);
  });

  // Slow path: returns the cached narrative if fresh, else triggers
  // an LLM call. Pass force=true to bypass the cache (Regenerate).
  ipc.handle(IPC_CHANNELS.weeklyGetNarrative, async (_e, year: unknown, week: unknown, force: unknown) => {
    const w = validWeek(year, week);
    if (!w) throw new Error('invalid year/week');
    return s.weeklyAggregator.getOrGenerateNarrative(w.year, w.week, {
      force: force === true,
    });
  });

  ipc.handle(IPC_CHANNELS.weeklyRegenerate, async (_e, year: unknown, week: unknown): Promise<WeeklyData> => {
    const w = validWeek(year, week);
    if (!w) throw new Error('invalid year/week');
    return s.weeklyAggregator.regenerateWeek(w.year, w.week);
  });

  ipc.handle(IPC_CHANNELS.weeklyExportMarkdown, async (_e, year: unknown, week: unknown): Promise<{ path: string | null; markdown: string }> => {
    const w = validWeek(year, week);
    if (!w) throw new Error('invalid year/week');
    const data = await s.weeklyAggregator.getWeek(w.year, w.week);
    const markdown = renderWeeklyMarkdown(data);
    const filename = `weekly-${w.year}-W${String(w.week).padStart(2, '0')}.md`;
    const result = await dialog.showSaveDialog({
      defaultPath: filename,
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    if (result.canceled || !result.filePath) return { path: null, markdown };
    fs.writeFileSync(result.filePath, markdown, 'utf8');
    return { path: result.filePath, markdown };
  });
}
