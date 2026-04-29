// electron/main/storage/weekly-summaries-repo.ts
//
// Cache for the LLM-generated weekly narrative + decisions list.
// We store these because regeneration is expensive (LM Studio call,
// 5-30s depending on model). Everything else the weekly view shows
// (meetings list, action items rollup) is queried live each time
// because it's already indexed and cheap.

import type Database from 'better-sqlite3';

export interface WeeklySummaryRow {
  isoYear: number;
  isoWeek: number;
  narrative: string;
  decisions: string[];
  inputHash: string;
  generatedAt: string;
}

function row(r: Record<string, unknown>): WeeklySummaryRow {
  return {
    isoYear: r.iso_year as number,
    isoWeek: r.iso_week as number,
    narrative: r.narrative as string,
    decisions: JSON.parse((r.decisions_json as string) || '[]') as string[],
    inputHash: r.input_hash as string,
    generatedAt: r.generated_at as string,
  };
}

export interface WeeklySummaryUpsert {
  isoYear: number;
  isoWeek: number;
  narrative: string;
  decisions: readonly string[];
  inputHash: string;
}

export class WeeklySummariesRepo {
  constructor(private readonly db: Database.Database) {}

  /** Returns the cached row for the week, or null if no row exists. */
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
        (iso_year, iso_week, narrative, decisions_json, input_hash, generated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (iso_year, iso_week) DO UPDATE SET
        narrative = excluded.narrative,
        decisions_json = excluded.decisions_json,
        input_hash = excluded.input_hash,
        generated_at = excluded.generated_at
    `).run(
      input.isoYear,
      input.isoWeek,
      input.narrative,
      JSON.stringify(input.decisions),
      input.inputHash,
      generatedAt,
    );
  }

  /** Drop the cached row for the week. Forces regeneration on next get. */
  clear(isoYear: number, isoWeek: number): void {
    this.db.prepare(
      'DELETE FROM weekly_summaries WHERE iso_year = ? AND iso_week = ?',
    ).run(isoYear, isoWeek);
  }
}
