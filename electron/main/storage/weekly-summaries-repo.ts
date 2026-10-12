// electron/main/storage/weekly-summaries-repo.ts
//
// Durable weekly reports. Narrative and structured sections are replaced
// together only after a successful explicit regeneration.

import type Database from 'better-sqlite3';
import type { WeeklyTheme, WeeklySnapshot } from '../ipc/contracts.js';

export interface WeeklySummaryRow {
  isoYear: number;
  isoWeek: number;
  narrative: string;
  themes: WeeklyTheme[];
  decisions: string[];
  inputHash: string;
  generatedAt: string;
  snapshot: WeeklySnapshot | null;
}

function row(r: Record<string, unknown>): WeeklySummaryRow {
  return {
    isoYear: r.iso_year as number,
    isoWeek: r.iso_week as number,
    narrative: r.narrative as string,
    themes: parseThemes(r.themes_json as string | undefined),
    decisions: JSON.parse((r.decisions_json as string) || '[]') as string[],
    inputHash: r.input_hash as string,
    generatedAt: r.generated_at as string,
    snapshot: r.snapshot_json ? JSON.parse(r.snapshot_json as string) as WeeklySnapshot : null,
  };
}

/** Tolerant parse of the cached themes_json blob — a malformed or absent
 *  value degrades to no themes rather than throwing on read. */
function parseThemes(json: string | undefined): WeeklyTheme[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? (parsed as WeeklyTheme[]) : [];
  } catch {
    return [];
  }
}

export interface WeeklySummaryUpsert {
  isoYear: number;
  isoWeek: number;
  narrative: string;
  themes: readonly WeeklyTheme[];
  decisions: readonly string[];
  inputHash: string;
  snapshot?: WeeklySnapshot;
}

export class WeeklySummariesRepo {
  constructor(private readonly db: Database.Database) {}

  /** Returns the saved report even when its source meetings have changed. */
  get(isoYear: number, isoWeek: number): WeeklySummaryRow | null {
    const r = this.db
      .prepare('SELECT * FROM weekly_summaries WHERE iso_year = ? AND iso_week = ?')
      .get(isoYear, isoWeek) as Record<string, unknown> | undefined;
    return r ? row(r) : null;
  }

  /** Idempotent upsert. Replaces any existing row for the week. */
  upsert(input: WeeklySummaryUpsert): void {
    const generatedAt = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO weekly_summaries
        (iso_year, iso_week, narrative, themes_json, decisions_json, input_hash, generated_at, snapshot_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (iso_year, iso_week) DO UPDATE SET
        narrative = excluded.narrative,
        themes_json = excluded.themes_json,
        decisions_json = excluded.decisions_json,
        input_hash = excluded.input_hash,
        generated_at = excluded.generated_at,
        snapshot_json = excluded.snapshot_json
    `).run(
      input.isoYear,
      input.isoWeek,
      input.narrative,
      JSON.stringify(input.themes),
      JSON.stringify(input.decisions),
      input.inputHash,
      generatedAt,
      input.snapshot ? JSON.stringify(input.snapshot) : null,
    );
  }

  /** Upgrade legacy rows once without changing their narrative or generation date. */
  captureLegacySnapshot(isoYear: number, isoWeek: number, snapshot: WeeklySnapshot): void {
    this.db.prepare(`UPDATE weekly_summaries SET snapshot_json = ?
      WHERE iso_year = ? AND iso_week = ? AND snapshot_json IS NULL`)
      .run(JSON.stringify(snapshot), isoYear, isoWeek);
  }

  /** Explicitly remove a saved report. Not used for source-change invalidation. */
  clear(isoYear: number, isoWeek: number): void {
    this.db.prepare(
      'DELETE FROM weekly_summaries WHERE iso_year = ? AND iso_week = ?',
    ).run(isoYear, isoWeek);
  }
}
