import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import type {
  ObsidianOptions,
  ObsidianConfig,
  ObsidianPreview,
  ObsidianStatus,
  ObsidianComparison,
} from '../../shared/obsidian.js';
import type { MeetingsRepo } from '../storage/meetings-repo.js';
import type { SpeakersRepo } from '../storage/speakers-repo.js';
import type { ActionItemsRepo } from '../storage/action-items-repo.js';
import type { SettingsRepo } from '../storage/settings-repo.js';
import { meetingFolderPath } from '../storage/meeting-folder.js';
import { atomicWrite, hash, identity, inside, readText, safePath, validateVault } from './files.js';
import {
  browse,
  filename,
  mergeNote,
  newNote,
  ownerOf,
  snapshot,
  templates,
  type Snapshot,
} from './render.js';

export const OptionsSchema = z
  .object({
    vault: z.string().min(1).max(4096),
    folder: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .regex(/^[\p{L}\p{N}][\p{L}\p{N} _-]*$/u)
      .refine((s) => !/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(s)),
    actionItems: z.boolean(),
    transcript: z.boolean(),
  })
  .strict();
interface Destination {
  id: string;
  vault: string;
  folder: string;
  identity: string;
  root_identity: string | null;
  last_success: string | null;
  browse_hash: string | null;
}
interface ExportRow {
  meeting_id: string;
  filename: string;
  revision: number;
  snapshot: string | null;
  pending: string | null;
  error: string | null;
}
interface Pending {
  before: string | null;
  after: string;
  snapshot: Snapshot;
  revision: number;
}
const pause = () => new Promise<void>((resolve) => setImmediate(resolve));
export class ObsidianSync {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private stopped = false;
  private error: string | null = null;
  private previewed?: {
    token: string;
    options: ObsidianOptions;
    identity: string;
    expires: number;
  };
  readonly owner: string;
  constructor(
    private readonly db: Database.Database,
    private readonly deps: {
      libraryRoot: string;
      meetings: MeetingsRepo;
      speakers: SpeakersRepo;
      items: ActionItemsRepo;
      settings: SettingsRepo;
      stale: (id: string) => boolean;
    },
  ) {
    const saved = db.prepare("SELECT value FROM obsidian_meta WHERE key='owner'").get() as
      | { value: string }
      | undefined;
    this.owner = saved?.value ?? randomUUID();
    if (!saved) db.prepare("INSERT INTO obsidian_meta VALUES ('owner', ?)").run(this.owner);
  }
  config(): ObsidianConfig | null {
    return this.deps.settings.get('obsidian');
  }
  private dest(config: ObsidianConfig): Destination {
    const d = this.db
      .prepare('SELECT * FROM obsidian_destinations WHERE id=?')
      .get(config.destination) as Destination | undefined;
    if (!d) throw new Error('Destination is not registered. Configure sync again.');
    return d;
  }
  private root(d: Destination): string {
    // Never recreate a vanished mount point or an owned folder that was removed.
    if (identity(d.vault) !== d.identity)
      throw new Error('Vault is unavailable or was replaced. Re-select it before syncing.');
    identity(path.join(d.vault, '.obsidian'));
    const root = safePath(d.vault, d.folder);
    if (d.root_identity && identity(root) !== d.root_identity)
      throw new Error('Sync folder was moved or replaced. Restore it before retrying.');
    const marker = readText(safePath(root, '.meetingnotes-owner.json'));
    if (marker !== JSON.stringify({ owner: this.owner, destination: d.id }))
      throw new Error('Sync folder ownership is missing or belongs to another library');
    identity(safePath(root, 'Notes'));
    fs.accessSync(root, fs.constants.W_OK);
    return root;
  }
  preview(input: unknown): ObsidianPreview {
    const options = OptionsSchema.parse(input);
    options.vault = validateVault(options.vault, this.deps.libraryRoot);
    const existing = this.db
      .prepare('SELECT * FROM obsidian_destinations WHERE vault=? AND folder=?')
      .get(options.vault, options.folder) as Destination | undefined;
    if (existing) this.root(existing);
    else if (fs.existsSync(safePath(options.vault, options.folder)))
      throw new Error(
        'That folder already exists and is not managed by this library. Choose a different sync folder name.',
      );
    const token = randomUUID();
    this.previewed = {
      token,
      options,
      identity: identity(options.vault),
      expires: Date.now() + 600_000,
    };
    const count = this.db
      .prepare("SELECT COUNT(*) AS n FROM meetings WHERE status='done' AND deleted_at IS NULL")
      .get() as { n: number };
    return { token, destination: path.join(options.vault, options.folder), meetings: count.n };
  }
  enable(token: string): ObsidianStatus {
    if (this.running) throw new Error('Sync is finishing a batch. Try again in a moment.');
    const p = this.previewed;
    if (!p || p.token !== token || Date.now() > p.expires)
      throw new Error('Preview expired. Review the destination again.');
    validateVault(p.options.vault, this.deps.libraryRoot);
    if (identity(p.options.vault) !== p.identity) throw new Error('Vault changed since preview');
    let d = this.db
      .prepare('SELECT * FROM obsidian_destinations WHERE vault=? AND folder=?')
      .get(p.options.vault, p.options.folder) as Destination | undefined;
    if (!d) {
      const id = randomUUID(),
        root = safePath(p.options.vault, p.options.folder);
      fs.mkdirSync(root); // Exclusive: no adoption of a folder created after preview.
      fs.mkdirSync(safePath(root, 'Notes'));
      fs.writeFileSync(
        safePath(root, '.meetingnotes-owner.json'),
        JSON.stringify({ owner: this.owner, destination: id }),
        { flag: 'wx', mode: 0o600 },
      );
      this.db
        .prepare(
          'INSERT INTO obsidian_destinations(id,vault,folder,identity,root_identity) VALUES (?,?,?,?,?)',
        )
        .run(id, p.options.vault, p.options.folder, p.identity, identity(root));
      d = this.db.prepare('SELECT * FROM obsidian_destinations WHERE id=?').get(id) as Destination;
      for (const [file, content] of Object.entries(templates(d.folder, this.owner)))
        atomicWrite(root, file, null, content);
    }
    this.root(d);
    if (!d.browse_hash) this.updateBrowse(d);
    this.deps.settings.set('obsidian', { ...p.options, destination: d.id, enabled: true });
    this.previewed = undefined;
    this.retry();
    return this.status();
  }
  disable(): ObsidianStatus {
    const c = this.config();
    if (c) this.deps.settings.set('obsidian', { ...c, enabled: false });
    return this.status();
  }
  start(): void {
    this.stopped = false;
    this.retry();
    this.timer = setInterval(() => {
      void this.run();
    }, 5000);
    this.timer.unref();
  }
  stop(): void {
    this.stopped = true;
    clearInterval(this.timer);
  }
  retry(): void {
    const c = this.config();
    if (!c?.enabled) return;
    this.db
      .prepare('UPDATE obsidian_exports SET revision=0 WHERE destination=?')
      .run(c.destination);
    this.error = null;
    void this.run();
  }
  status(): ObsidianStatus {
    const c = this.config();
    if (!c)
      return {
        config: null,
        running: false,
        lastSuccess: null,
        error: this.error,
        pending: 0,
        synced: 0,
        issues: [],
      };
    const d = this.dest(c);
    const count = this.db
      .prepare(
        'SELECT COUNT(*) AS n FROM obsidian_exports WHERE destination=? AND snapshot IS NOT NULL',
      )
      .get(d.id) as { n: number };
    const pending = this.pendingCount(d.id);
    const issues = this.db
      .prepare(
        "SELECT meeting_id AS id, error, json_extract(snapshot,'$.data.title') AS title FROM obsidian_exports WHERE destination=? AND error IS NOT NULL ORDER BY meeting_id LIMIT 100",
      )
      .all(d.id) as { id: string; error: string; title: string | null }[];
    return {
      config: c,
      running: this.running,
      error: this.error,
      lastSuccess: d.last_success,
      pending: pending.n,
      synced: count.n,
      issues: issues.map((r) => ({
        id: r.id,
        error: r.error,
        title: r.title ?? this.deps.meetings.findById(r.id)?.title ?? r.id,
      })),
    };
  }
  private pendingCount(destination: string): { n: number } {
    return this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM obsidian_revisions r
      LEFT JOIN meetings m ON m.id=r.meeting_id
      LEFT JOIN obsidian_exports e ON e.meeting_id=r.meeting_id AND e.destination=?
      WHERE (e.revision IS NULL OR r.revision != e.revision OR (e.pending IS NOT NULL AND e.error IS NULL))
      AND ((m.status='done' AND m.deleted_at IS NULL) OR e.snapshot IS NOT NULL OR e.pending IS NOT NULL)
      `,
      )
      .get(destination) as { n: number };
  }
  private row(destination: string, id: string): ExportRow | undefined {
    return this.db
      .prepare('SELECT * FROM obsidian_exports WHERE destination=? AND meeting_id=?')
      .get(destination, id) as ExportRow | undefined;
  }
  private source(id: string, config: ObsidianConfig, previous?: Snapshot): Snapshot | null {
    const m = this.deps.meetings.findById(id);
    if (!m || m.deletedAt)
      return previous
        ? snapshot(
            { ...previous.data, deleted: true, updated: m?.updatedAt ?? previous.data.updated },
            this.owner,
          )
        : null;
    if (m.status !== 'done') return null;
    const folder = meetingFolderPath(this.deps.libraryRoot, m.slug);
    if (!inside(fs.realpathSync(this.deps.libraryRoot), fs.realpathSync(folder)))
      throw new Error('Meeting folder points outside the source library');
    const summary = readText(path.join(folder, 'summary.md'));
    if (summary === null)
      throw new Error('Meeting summary is unavailable; retaining the previous export');
    const items = this.deps.items.listByMeeting(id);
    const date =
      m.startedAt && Number.isFinite(Date.parse(m.startedAt)) ? m.startedAt : m.createdAt;
    return snapshot(
      {
        id,
        title: m.title,
        date: new Date(date).toISOString(),
        groupId: m.groupId,
        group: m.groupName ?? 'Ungrouped',
        duration: m.durationS,
        participants: this.deps.speakers
          .listForMeeting(id)
          .map((s) => s.displayName ?? s.localLabel),
        openActions: items.filter((i) => i.status !== 'done').length,
        updated: m.updatedAt,
        deleted: false,
        stale: this.deps.stale(id),
        summary,
        items: config.actionItems ? items : [],
        transcript: config.transcript
          ? (readText(path.join(folder, 'transcript.md')) ?? undefined)
          : undefined,
      },
      this.owner,
    );
  }
  private finalize(d: string, id: string, pending: Pending): void {
    this.db
      .prepare(
        'UPDATE obsidian_exports SET snapshot=?, revision=?, pending=NULL, error=NULL WHERE destination=? AND meeting_id=?',
      )
      .run(JSON.stringify(pending.snapshot), pending.revision, d, id);
  }
  private write(
    d: Destination,
    row: ExportRow,
    before: string | null,
    after: string,
    next: Snapshot,
    revision: number,
  ): void {
    if (Buffer.byteLength(after) > 12_000_000)
      throw new Error(
        'Export exceeds the 12 MB safety limit. Turn off transcript inclusion or shorten the note.',
      );
    const pending: Pending = { before, after, snapshot: next, revision };
    this.db
      .prepare('UPDATE obsidian_exports SET pending=? WHERE destination=? AND meeting_id=?')
      .run(JSON.stringify(pending), d.id, row.meeting_id);
    if (before !== after) atomicWrite(this.root(d), row.filename, before, after);
    this.finalize(d.id, row.meeting_id, pending);
  }
  private async findRenamed(root: string, id: string): Promise<string | undefined> {
    const dir = safePath(root, 'Notes');
    const matches: string[] = [];
    const entries = fs.readdirSync(dir);
    if (entries.length > 5000)
      throw new Error(
        'Note was moved. Restore its original path; automatic rename search is limited to 5,000 files.',
      );
    for (const name of entries) {
      if (!name.endsWith('.md')) continue;
      try {
        const note = readText(safePath(root, `Notes/${name}`));
        if (note) {
          const info = ownerOf(note);
          if (info.id === id && info.owner === this.owner) matches.push(`Notes/${name}`);
        }
      } catch {
        /* unrelated or unreadable files cannot establish identity */
      }
      await pause();
    }
    if (matches.length > 1)
      throw new Error('Multiple copies have this meeting ID. Resolve duplicates before retrying.');
    return matches[0];
  }
  async run(): Promise<void> {
    const c = this.config();
    if (this.running || this.stopped || !c?.enabled) return;
    this.running = true;
    try {
      const d = this.dest(c),
        root = this.root(d);
      const candidates = this.db
        .prepare(
          `SELECT r.meeting_id AS id,r.revision FROM obsidian_revisions r
        LEFT JOIN meetings m ON m.id=r.meeting_id
        LEFT JOIN obsidian_exports e ON e.meeting_id=r.meeting_id AND e.destination=?
        WHERE (e.revision IS NULL OR r.revision!=e.revision OR (e.pending IS NOT NULL AND e.error IS NULL))
        AND ((m.status='done' AND m.deleted_at IS NULL) OR e.snapshot IS NOT NULL OR e.pending IS NOT NULL)
        ORDER BY r.meeting_id LIMIT 100`,
        )
        .all(d.id) as { id: string; revision: number }[];
      for (const candidate of candidates) {
        await pause();
        if (this.stopped || !this.config()?.enabled || this.config()?.destination !== d.id) break;
        this.root(d);
        let row = this.row(d.id, candidate.id);
        try {
          if (row?.pending) {
            const p = JSON.parse(row.pending) as Pending;
            const current = readText(safePath(root, row.filename));
            if (current === p.after) this.finalize(d.id, candidate.id, p);
            else if (current === p.before)
              this.write(d, row, current, p.after, p.snapshot, p.revision);
            else
              throw new Error(
                'File changed after an interrupted write. Restore the prior file or inspect the conflict.',
              );
            row = this.row(d.id, candidate.id);
          }
          const previous = row?.snapshot ? (JSON.parse(row.snapshot) as Snapshot) : undefined;
          const next = this.source(candidate.id, c, previous);
          if (!next) {
            if (row)
              this.db
                .prepare(
                  'UPDATE obsidian_exports SET revision=? WHERE destination=? AND meeting_id=?',
                )
                .run(candidate.revision, d.id, candidate.id);
            continue;
          }
          if (!row) {
            this.db
              .prepare(
                'INSERT INTO obsidian_exports(destination,meeting_id,filename) VALUES (?,?,?)',
              )
              .run(d.id, candidate.id, filename(next.data));
            row = this.row(d.id, candidate.id)!;
          } else if (!previous && !row.pending && row.filename.startsWith('Notes/unavailable-')) {
            row.filename = filename(next.data);
            this.db
              .prepare(
                'UPDATE obsidian_exports SET filename=? WHERE destination=? AND meeting_id=?',
              )
              .run(row.filename, d.id, candidate.id);
          }
          let current = readText(safePath(root, row.filename));
          if (previous && current === null) {
            const renamed = await this.findRenamed(root, candidate.id);
            if (!this.config()?.enabled || this.stopped) break;
            this.root(d);
            if (!renamed)
              throw new Error(
                'Exported note is missing or moved outside Notes. Restore it; sync will not recreate a deleted note.',
              );
            this.db
              .prepare(
                'UPDATE obsidian_exports SET filename=? WHERE destination=? AND meeting_id=?',
              )
              .run(renamed, d.id, candidate.id);
            row.filename = renamed;
            current = readText(safePath(root, row.filename));
          }
          if (!previous && current !== null)
            throw new Error('A file already exists at this path; it will not be overwritten');
          const after = previous ? mergeNote(current!, previous, next) : newNote(next);
          this.write(d, row, current, after, next, candidate.revision);
        } catch (error) {
          // Keep the prior snapshot and all user bytes; errors do not fail meetings.
          if (!row) {
            this.db
              .prepare(
                'INSERT OR IGNORE INTO obsidian_exports(destination,meeting_id,filename) VALUES (?,?,?)',
              )
              .run(d.id, candidate.id, `Notes/unavailable-${hash(candidate.id)}.md`);
          }
          this.db
            .prepare(
              'UPDATE obsidian_exports SET error=?, revision=? WHERE destination=? AND meeting_id=?',
            )
            .run(String((error as Error).message), candidate.revision, d.id, candidate.id);
        }
      }
      if (candidates.length && this.config()?.enabled && !this.stopped) {
        this.updateBrowse(d);
        this.error = null;
        if (
          !this.db
            .prepare(
              'SELECT 1 FROM obsidian_exports WHERE destination=? AND error IS NOT NULL LIMIT 1',
            )
            .get(d.id)
        ) {
          this.db
            .prepare('UPDATE obsidian_destinations SET last_success=? WHERE id=?')
            .run(new Date().toISOString(), d.id);
        }
      }
    } catch (error) {
      this.error = (error as Error).message;
    } finally {
      this.running = false;
    }
  }
  private updateBrowse(d: Destination, recreate = false): void {
    const root = this.root(d);
    // Read index metadata only, never every transcript/summary into memory.
    const rows = this.db
      .prepare(
        `SELECT filename, json_extract(snapshot,'$.data.title') AS title,
      json_extract(snapshot,'$.data.date') AS date, json_extract(snapshot,'$.data.group') AS group_name,
      json_extract(snapshot,'$.data.deleted') AS deleted FROM obsidian_exports
      WHERE destination=? AND snapshot IS NOT NULL`,
      )
      .all(d.id) as {
      filename: string;
      title: string;
      date: string;
      group_name: string;
      deleted: number;
    }[];
    const output = browse(
      rows.map((r) => ({
        filename: r.filename,
        snapshot: {
          data: { title: r.title, date: r.date, group: r.group_name, deleted: Boolean(r.deleted) },
        },
      })),
    );
    const current = readText(safePath(root, 'Browse.md'));
    const stored = (
      this.db
        .prepare('SELECT browse_hash FROM obsidian_destinations WHERE id=?')
        .get(d.id) as Destination
    ).browse_hash;
    if (current === output) {
      // Repair a crash after the atomic index write but before its hash commit.
      if (stored !== hash(output))
        this.db
          .prepare('UPDATE obsidian_destinations SET browse_hash=? WHERE id=?')
          .run(hash(output), d.id);
      return;
    }
    if (
      !recreate &&
      ((current !== null && hash(current) !== stored) || (current === null && stored))
    )
      throw new Error(
        'Browse.md was edited or removed. Use Recreate views to restore it; meetings still sync.',
      );
    atomicWrite(root, 'Browse.md', current, output);
    this.db
      .prepare('UPDATE obsidian_destinations SET browse_hash=? WHERE id=?')
      .run(hash(output), d.id);
  }
  folder(): string {
    const c = this.config();
    if (!c) throw new Error('Configure a vault first');
    return this.root(this.dest(c));
  }
  recreateViews(): void {
    if (this.running) throw new Error('Wait for the current sync batch to finish');
    const c = this.config();
    if (!c) throw new Error('Configure a vault first');
    const d = this.dest(c),
      root = this.root(d);
    for (const [name, content] of Object.entries(templates(d.folder, this.owner))) {
      const before = readText(safePath(root, name));
      if (before !== null) atomicWrite(root, `${name}.${randomUUID()}.backup`, null, before);
      atomicWrite(root, name, before, content);
    }
    const before = readText(safePath(root, 'Browse.md'));
    if (before !== null) atomicWrite(root, `Browse.md.${randomUUID()}.backup`, null, before);
    this.updateBrowse(d, true);
    this.error = null;
  }
  compare(id: string): ObsidianComparison {
    const c = this.config();
    if (!c) throw new Error('Configure a vault first');
    const d = this.dest(c),
      row = this.row(d.id, id);
    if (!row?.snapshot)
      throw new Error(
        'No owned export exists to compare. Resolve the reported path or source issue and retry.',
      );
    const prev = JSON.parse(row.snapshot) as Snapshot,
      next = this.source(id, c, prev);
    if (!next) throw new Error('Meeting is still processing; try again when it finishes');
    const current = readText(safePath(this.root(d), row.filename));
    if (current === null)
      return {
        id,
        revision: '',
        current: 'File missing. Restore its path or move it back into Notes.',
        proposed: newNote(next),
        canReplace: false,
      };
    let canReplace = true;
    let proposed = newNote(next);
    try {
      proposed = mergeNote(current, prev, next, true);
    } catch {
      canReplace = false;
    }
    return {
      id,
      revision: hash(JSON.stringify([c, current, next])),
      current,
      proposed,
      canReplace,
    };
  }
  replace(id: string, revision: string): void {
    if (this.running) throw new Error('Wait for the current sync batch to finish');
    const comparison = this.compare(id);
    if (!comparison.canReplace || comparison.revision !== revision)
      throw new Error('Comparison changed or ownership is unsafe. Review the note again.');
    const c = this.config()!,
      d = this.dest(c),
      row = this.row(d.id, id)!;
    const next = this.source(id, c, JSON.parse(row.snapshot!))!;
    const sourceRevision = (
      this.db.prepare('SELECT revision FROM obsidian_revisions WHERE meeting_id=?').get(id) as {
        revision: number;
      }
    ).revision;
    // Preserve the exact externally edited version before an explicitly confirmed replace.
    atomicWrite(this.root(d), `${row.filename}.${randomUUID()}.backup`, null, comparison.current);
    this.write(d, row, comparison.current, comparison.proposed, next, sourceRevision);
    this.updateBrowse(d);
  }
}
