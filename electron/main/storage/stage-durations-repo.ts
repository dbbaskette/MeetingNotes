import type Database from 'better-sqlite3';
import { MAX_SAMPLES_PER_BUCKET } from '../lib/stage-eta.js';

/** Per-stage duration samples for the learned ETA. One row per stage run,
 *  keyed by (stage, size_bucket). Reads hand raw samples to the pure
 *  stage-eta module, which turns them into a median estimate. */
export class StageDurationsRepo {
  constructor(private readonly db: Database.Database) {}

  /** Insert one duration sample, then prune this (stage, size_bucket) to the
   *  most-recent MAX_SAMPLES_PER_BUCKET rows so the table stays bounded and the
   *  estimate tracks the user's current machine/model. */
  record(stage: string, sizeBucket: number, durationMs: number): void {
    const insert = this.db.prepare(
      'INSERT INTO stage_durations (stage, size_bucket, duration_ms, recorded_at) VALUES (?, ?, ?, ?)',
    );
    // Delete every row for this (stage, bucket) except the most-recent N by id.
    // id is a monotonic AUTOINCREMENT, so ordering by id DESC == newest-first
    // and avoids ties on recorded_at when several land in the same millisecond.
    const prune = this.db.prepare(`
      DELETE FROM stage_durations
       WHERE stage = ? AND size_bucket = ?
         AND id NOT IN (
           SELECT id FROM stage_durations
            WHERE stage = ? AND size_bucket = ?
            ORDER BY id DESC
            LIMIT ?
         )
    `);
    const tx = this.db.transaction(() => {
      insert.run(stage, sizeBucket, Math.round(durationMs), new Date().toISOString());
      prune.run(stage, sizeBucket, stage, sizeBucket, MAX_SAMPLES_PER_BUCKET);
    });
    tx();
  }

  /** The most-recent `limit` duration_ms values for this (stage, size_bucket),
   *  newest first. Empty array when the bucket has never been seen. */
  recentSamples(stage: string, sizeBucket: number, limit: number): number[] {
    const rows = this.db.prepare(`
      SELECT duration_ms FROM stage_durations
       WHERE stage = ? AND size_bucket = ?
       ORDER BY id DESC
       LIMIT ?
    `).all(stage, sizeBucket, limit) as { duration_ms: number }[];
    return rows.map((r) => r.duration_ms);
  }
}
