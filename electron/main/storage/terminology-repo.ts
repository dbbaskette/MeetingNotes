import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import type { TermArtifact, TermInput, TermRule } from '../../shared/terminology.js';

const term = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .refine(
    (s) =>
      ![...s].some((c) => c.charCodeAt(0) < 32) && s.split(/\s+/).length <= 5 && /\p{L}/u.test(s),
    'Use a word or short phrase',
  );
export const TermInputSchema = z.object({
  source: term,
  replacement: term,
  groupId: z.string().min(1).nullable(),
  mode: z.enum(['suggest', 'automatic']),
  caseSensitive: z.boolean(),
  enabled: z.boolean(),
});
const norm = (s: string): string => s.normalize('NFC').toLowerCase().replace(/\s+/g, ' ');

export class TerminologyRepo {
  constructor(readonly db: Database.Database) {}
  list(): TermRule[] {
    return (
      this.db.prepare('SELECT * FROM terminology_rules ORDER BY source, id').all() as Record<
        string,
        unknown
      >[]
    ).map((r) => ({
      id: r.id as string,
      source: r.source as string,
      replacement: r.replacement as string,
      groupId: r.group_id as string | null,
      mode: r.mode as TermRule['mode'],
      caseSensitive: Boolean(r.case_sensitive),
      enabled: Boolean(r.enabled),
      revision: r.revision as number,
    }));
  }
  applicable(groupId: string | null): TermRule[] {
    const rules = this.list().filter(
      (r) => r.enabled && (r.groupId === null || r.groupId === groupId),
    );
    const overrides = new Set(rules.filter((r) => r.groupId !== null).map((r) => norm(r.source)));
    return rules.filter((r) => r.groupId !== null || !overrides.has(norm(r.source)));
  }
  save(raw: TermInput, id?: string): TermRule {
    const input = TermInputSchema.parse(raw);
    if (input.source === input.replacement) throw new Error('Choose a different replacement');
    if (input.groupId && !this.db.prepare('SELECT id FROM groups WHERE id = ?').get(input.groupId))
      throw new Error('Group no longer exists');
    return this.db.transaction(() => {
      const others = this.list().filter((r) => r.id !== id);
      const existing = id ? this.list().find((r) => r.id === id) : undefined;
      if (id && !existing) throw new Error('Correction no longer exists');
      if (!existing && others.length >= 500)
        throw new Error('The dictionary supports up to 500 corrections');
      if (others.some((r) => r.groupId === input.groupId && norm(r.source) === norm(input.source)))
        throw new Error(
          'A correction for this term already exists in this scope. Edit it instead.',
        );
      // Check each effective scope, including group overrides of library rules.
      const all = [...others, { ...input, id: id ?? 'new', revision: 1 }];
      for (const group of new Set([null, ...all.map((r) => r.groupId)])) {
        const edges = new Map<string, string>();
        for (const r of all
          .filter((r) => r.enabled && (r.groupId === null || r.groupId === group))
          .sort((a, b) => Number(a.groupId !== null) - Number(b.groupId !== null))) {
          if (norm(r.source) !== norm(r.replacement))
            edges.set(norm(r.source), norm(r.replacement));
        }
        for (const start of edges.keys()) {
          const visited = new Set<string>();
          let at: string | undefined = start;
          while (at && edges.has(at)) {
            if (visited.has(at))
              throw new Error('These corrections would create a replacement cycle');
            visited.add(at);
            at = edges.get(at);
          }
        }
      }
      const result = { ...input, id: id ?? randomUUID(), revision: (existing?.revision ?? 0) + 1 };
      const now = new Date().toISOString();
      this.db
        .prepare(
          `INSERT INTO terminology_rules VALUES (@id,@source,@replacement,@groupId,@mode,@caseSensitive,@enabled,@revision,@now,@now)
        ON CONFLICT(id) DO UPDATE SET source=excluded.source,replacement=excluded.replacement,group_id=excluded.group_id,
        mode=excluded.mode,case_sensitive=excluded.case_sensitive,enabled=excluded.enabled,revision=excluded.revision,updated_at=excluded.updated_at`,
        )
        .run({
          ...result,
          caseSensitive: Number(result.caseSensitive),
          enabled: Number(result.enabled),
          now,
        });
      return result;
    })();
  }
  delete(id: string): void {
    this.db.prepare('DELETE FROM terminology_rules WHERE id = ?').run(id);
  }
  offers(enabled?: boolean): boolean {
    if (enabled !== undefined)
      this.db
        .prepare(
          "INSERT INTO terminology_preferences VALUES ('offers', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        )
        .run(String(enabled));
    return (
      (
        this.db.prepare("SELECT value FROM terminology_preferences WHERE key='offers'").get() as
          | { value: string }
          | undefined
      )?.value !== 'false'
    );
  }
  read<T>(meetingId: string, artifact: TermArtifact): T | undefined {
    const row = this.db
      .prepare('SELECT state_json FROM terminology_documents WHERE meeting_id=? AND artifact=?')
      .get(meetingId, artifact) as { state_json: string } | undefined;
    return row ? (JSON.parse(row.state_json) as T) : undefined;
  }
  write(meetingId: string, artifact: TermArtifact, state: unknown, pending: unknown = null): void {
    this.db
      .prepare(
        `INSERT INTO terminology_documents VALUES (?,?,?,?) ON CONFLICT(meeting_id,artifact)
      DO UPDATE SET state_json=excluded.state_json,pending_json=excluded.pending_json`,
      )
      .run(meetingId, artifact, JSON.stringify(state), pending ? JSON.stringify(pending) : null);
  }
  pending(): Array<{ meeting_id: string; artifact: TermArtifact; pending_json: string }> {
    return this.db
      .prepare(
        'SELECT meeting_id,artifact,pending_json FROM terminology_documents WHERE pending_json IS NOT NULL',
      )
      .all() as ReturnType<TerminologyRepo['pending']>;
  }
}
