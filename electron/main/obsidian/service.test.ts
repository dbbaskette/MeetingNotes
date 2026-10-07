import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parse } from 'yaml';
import { openDb } from '../storage/db.js';
import { runMigrations } from '../storage/migrations.js';
import { MeetingsRepo } from '../storage/meetings-repo.js';
import { GroupsRepo } from '../storage/groups-repo.js';
import { SpeakersRepo } from '../storage/speakers-repo.js';
import { ActionItemsRepo } from '../storage/action-items-repo.js';
import { SettingsRepo } from '../storage/settings-repo.js';
import { ObsidianSync } from './service.js';
import { atomicWrite, hash, safePath } from './files.js';
import { snapshot, newNote, mergeNote, type NoteData } from './render.js';

let temp: string, library: string, vault: string;
let db: ReturnType<typeof openDb>,
  meetings: MeetingsRepo,
  groups: GroupsRepo,
  speakers: SpeakersRepo,
  items: ActionItemsRepo,
  settings: SettingsRepo,
  sync: ObsidianSync;
const opts = () => ({ vault, folder: 'MeetingNotes', actionItems: true, transcript: false });
const root = () => path.join(vault, 'MeetingNotes');
const make = () =>
  new ObsidianSync(db, {
    libraryRoot: library,
    meetings,
    speakers,
    items,
    settings,
    stale: () => false,
  });
function add(id = 'one', title = 'Planning'): void {
  meetings.insert({
    id,
    slug: id,
    title,
    startedAt: '2026-10-02T13:00:00Z',
    durationS: 300,
    audioPath: '/disposable/audio.m4a',
    status: 'done',
    pipelineStage: 'done',
  });
  fs.mkdirSync(path.join(library, 'meetings', id), { recursive: true });
  fs.writeFileSync(
    path.join(library, 'meetings', id, 'summary.md'),
    '## Overview\nSLSA improvements.',
  );
  fs.writeFileSync(path.join(library, 'meetings', id, 'transcript.md'), 'A long transcript');
}
async function idle(): Promise<void> {
  for (let i = 0; sync.status().running && i < 10000; i++)
    await new Promise<void>((r) => setImmediate(r));
  expect(sync.status().running).toBe(false);
}
async function enable(): Promise<void> {
  sync.enable(sync.preview(opts()).token);
  await idle();
}
function exported(id = 'one'): string {
  const r = db.prepare('SELECT filename FROM obsidian_exports WHERE meeting_id=?').get(id) as {
    filename: string;
  };
  return path.join(root(), r.filename);
}
beforeEach(() => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-obsidian-'));
  library = path.join(temp, 'library');
  vault = path.join(temp, 'vault');
  fs.mkdirSync(path.join(vault, '.obsidian'), { recursive: true });
  db = openDb(path.join(library, 'db.sqlite'));
  meetings = new MeetingsRepo(db);
  groups = new GroupsRepo(db);
  speakers = new SpeakersRepo(db);
  items = new ActionItemsRepo(db);
  settings = new SettingsRepo(db);
  sync = make();
  add();
});
afterEach(async () => {
  await idle();
  sync.stop();
  vi.restoreAllMocks();
  db.close();
  fs.rmSync(temp, { recursive: true, force: true });
});

describe('Obsidian sync', () => {
  it('resumes on startup and retries only failures without resetting unchanged exports', async () => {
    await enable();
    const unchanged = db.prepare('SELECT revision FROM obsidian_exports WHERE meeting_id=?').get('one');
    const read = vi.spyOn(fs, 'openSync');
    sync.start(); await idle();
    sync.retry(); await idle();
    expect(db.prepare('SELECT revision FROM obsidian_exports WHERE meeting_id=?').get('one')).toEqual(unchanged);
    expect(read.mock.calls.filter(([file]) => typeof file === 'string' && file.endsWith('summary.md'))).toHaveLength(0);
    sync.retry(true); await idle();
    expect(read.mock.calls.some(([file]) => typeof file === 'string' && file.endsWith('summary.md'))).toBe(true);
  });
  it('rechecks content when options change, including a previously used destination', async () => {
    await enable(); expect(fs.readFileSync(exported(),'utf8')).not.toContain('A long transcript');
    sync.enable(sync.preview({...opts(),transcript: true}).token); await idle();
    expect(fs.readFileSync(exported(),'utf8')).toContain('A long transcript');
    sync.enable(sync.preview({...opts(),folder: 'Other'}).token); await idle();
    sync.enable(sync.preview(opts()).token); await idle();
    expect(fs.readFileSync(exported(),'utf8')).not.toContain('A long transcript');
  });
  it('upgrades an existing v18 library additively and seeds catch-up revisions', () => {
    const original = meetings.findById('one');
    const triggers = db
      .prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'obsidian_%'")
      .all() as { name: string }[];
    for (const t of triggers) db.exec(`DROP TRIGGER "${t.name}"`);
    db.exec(
      'DROP TABLE notes_restore_pending; DROP TABLE notes_versions; DROP TABLE obsidian_exports; DROP TABLE obsidian_destinations; DROP TABLE obsidian_meta; DROP TABLE obsidian_revisions; UPDATE schema_version SET version=18;',
    );
    runMigrations(db);
    expect(meetings.findById('one')).toEqual(original);
    expect(db.prepare('SELECT version FROM schema_version').get()).toEqual({ version: 20 });
    expect(db.prepare('SELECT * FROM obsidian_revisions').get()).toEqual({
      meeting_id: 'one',
      revision: 1,
    });
    expect(settings.get('obsidian')).toBeNull();
  });
  it('previews without writing, requires the token, and initializes one note and several views', async () => {
    const p = sync.preview(opts());
    expect(p.meetings).toBe(1);
    expect(fs.existsSync(root())).toBe(false);
    expect(() => sync.enable('wrong')).toThrow('Preview');
    sync.enable(p.token);
    await idle();
    expect(fs.readdirSync(path.join(root(), 'Notes'))).toHaveLength(1);
    const note = fs.readFileSync(exported(), 'utf8');
    expect(note).toContain('meetingnotes://open?id=one');
    expect(note).not.toContain('A long transcript');
    const base = parse(fs.readFileSync(path.join(root(), 'Meetings.base'), 'utf8'));
    expect(base.views.map((v: { name: string }) => v.name)).toEqual([
      'By group',
      'By date',
      'Ungrouped',
    ]);
    expect(sync.status().synced).toBe(1);
    expect(sync.status().issues).toEqual([]);
  });
  it('rejects unsafe destinations, overlaps, collisions and symlink escapes', async () => {
    expect(() => sync.preview({ ...opts(), vault: 'relative' })).toThrow();
    expect(() => sync.preview({ ...opts(), folder: '../escape' })).toThrow();
    fs.mkdirSync(path.join(library, '.obsidian'));
    expect(() => sync.preview({ ...opts(), vault: library })).toThrow('separate');
    fs.mkdirSync(root());
    expect(() => sync.preview(opts())).toThrow('already exists');
    fs.rmdirSync(root());
    await enable();
    fs.symlinkSync(temp, path.join(root(), 'escape'));
    expect(() => safePath(root(), 'escape/secret.md')).toThrow('Symbolic');
    expect(() => safePath(root(), '../../secret.md')).toThrow('Unsafe');
  });
  it('preserves personal notes and unknown properties and skips unchanged output', async () => {
    await enable();
    const file = exported();
    const original = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(
      file,
      original.replace('---\n', '---\npersonal_tag: important\n') + '\nMy private annotation.\n',
    );
    const before = fs.statSync(file).mtimeMs;
    await sync.run();
    expect(fs.statSync(file).mtimeMs).toBe(before);
    meetings.updateTitle('one', 'New title');
    await sync.run();
    expect(exported()).toBe(file);
    const updated = fs.readFileSync(file, 'utf8');
    expect(updated).toContain('personal_tag: important');
    expect(updated).toContain('My private annotation.');
    expect(updated).toContain('# New title');
    const time = fs.statSync(file).mtimeMs;
    sync.retry();
    await idle();
    expect(fs.statSync(file).mtimeMs).toBe(time);
  });
  it('holds external edits, rejects stale comparison, and backs up explicit replacement', async () => {
    await enable();
    const file = exported();
    fs.writeFileSync(
      file,
      fs.readFileSync(file, 'utf8').replace('SLSA improvements.', 'External content.'),
    );
    meetings.updateTitle('one', 'Changed');
    await sync.run();
    expect(sync.status().issues).toHaveLength(1);
    const cmp = sync.compare('one');
    expect(cmp.canReplace).toBe(true);
    expect(cmp.current).toContain('External content.');
    fs.appendFileSync(file, '\nAnother personal note');
    expect(() => sync.replace('one', cmp.revision)).toThrow('changed');
    sync.replace('one', sync.compare('one').revision);
    expect(fs.readFileSync(file, 'utf8')).toContain('Another personal note');
    expect(fs.readFileSync(file, 'utf8')).toContain('SLSA improvements.');
    expect(fs.readdirSync(path.dirname(file)).filter((f) => f.endsWith('.backup'))).toHaveLength(1);
    expect(sync.status().issues).toHaveLength(0);
  });
  it('observes group renames/moves, action edits and terminology updates durably', async () => {
    await enable();
    const file = exported();
    const g = groups.create('Engineering');
    groups.assign(['one'], g.id);
    await sync.run();
    expect(fs.readFileSync(file, 'utf8')).toContain('mn_group: Engineering');
    groups.rename(g.id, 'Platform');
    await sync.run();
    expect(fs.readFileSync(file, 'utf8')).toContain('mn_group: Platform');
    items.replaceForMeeting('one', [{ text: 'Send update', owner: 'Dan', due_date: null }]);
    await sync.run();
    expect(fs.readFileSync(file, 'utf8')).toContain('Send update');
    fs.writeFileSync(path.join(library, 'meetings', 'one', 'summary.md'), 'Corrected summary');
    db.prepare("INSERT INTO terminology_documents VALUES ('one','summary','{}',NULL)").run();
    sync = make();
    await sync.run();
    expect(fs.readFileSync(file, 'utf8')).toContain('Corrected summary');
    groups.delete(g.id);
    await sync.run();
    expect(fs.readFileSync(file, 'utf8')).toContain('mn_group: Ungrouped');
  });
  it('keeps completed exports during reprocessing and retains removed sources', async () => {
    await enable();
    const file = exported(),
      before = fs.readFileSync(file, 'utf8');
    meetings.updateStatus('one', 'processing');
    fs.writeFileSync(path.join(library, 'meetings', 'one', 'summary.md'), 'Partial');
    await sync.run();
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    meetings.updateStatus('one', 'done');
    await sync.run();
    expect(fs.readFileSync(file, 'utf8')).toContain('Partial');
    db.prepare("UPDATE meetings SET deleted_at='2026-10-02' WHERE id='one'").run();
    await sync.run();
    expect(fs.readFileSync(file, 'utf8')).toContain('mn_removed: true');
    expect(fs.readFileSync(path.join(root(), 'Browse.md'), 'utf8')).not.toContain('Planning');
    db.prepare("UPDATE meetings SET deleted_at=NULL WHERE id='one'").run();
    await sync.run();
    expect(fs.readFileSync(file, 'utf8')).toContain('mn_removed: false');
    db.prepare("DELETE FROM meetings WHERE id='one'").run();
    await sync.run();
    expect(fs.readFileSync(file, 'utf8')).toContain('mn_removed: true');
  });
  it('follows a renamed owned note and flags missing notes without recreating them', async () => {
    await enable();
    const old = exported(),
      renamed = path.join(root(), 'Notes', 'Renamed.md');
    fs.renameSync(old, renamed);
    meetings.updateTitle('one', 'Changed');
    await sync.run();
    expect(exported()).toBe(renamed);
    expect(fs.existsSync(old)).toBe(false);
    fs.unlinkSync(renamed);
    meetings.updateTitle('one', 'Again');
    await sync.run();
    expect(fs.existsSync(renamed)).toBe(false);
    expect(sync.status().issues[0]?.error).toContain('missing');
  });
  it('pauses unavailable vaults and never recreates them', async () => {
    await enable();
    fs.renameSync(vault, `${vault}-away`);
    meetings.updateTitle('one', 'Changed');
    await sync.run();
    expect(sync.status().error).toBeTruthy();
    expect(fs.existsSync(vault)).toBe(false);
    fs.renameSync(`${vault}-away`, vault);
    await sync.run();
    expect(sync.status().error).toBe(null);
  });
  it('disables writes and changes destinations only after a fresh preview', async () => {
    await enable();
    const before = fs.readFileSync(exported(), 'utf8');
    sync.disable();
    meetings.updateTitle('one', 'New');
    await sync.run();
    expect(fs.readFileSync(exported(), 'utf8')).toBe(before);
    const p = sync.preview({ ...opts(), folder: 'Other meetings', transcript: true });
    sync.enable(p.token);
    await idle();
    const other = path.join(vault, 'Other meetings', 'Notes');
    expect(fs.readdirSync(other)).toHaveLength(1);
    expect(fs.readFileSync(path.join(other, fs.readdirSync(other)[0]!), 'utf8')).toContain(
      'A long transcript',
    );
    expect(fs.existsSync(root())).toBe(true);
  });
  it('does not overwrite customized views, and explicit repair preserves backups', async () => {
    await enable();
    const base = path.join(root(), 'Meetings.base');
    fs.writeFileSync(base, 'My custom base');
    meetings.updateTitle('one', 'Changed');
    await sync.run();
    expect(fs.readFileSync(base, 'utf8')).toBe('My custom base');
    fs.writeFileSync(path.join(root(), 'Browse.md'), 'My index');
    meetings.updateTitle('one', 'Changed again');
    await sync.run();
    expect(sync.status().error).toContain('Browse.md');
    await sync.run();
    expect(sync.status().error).toContain('Browse.md');
    sync.recreateViews();
    expect(parse(fs.readFileSync(base, 'utf8')).views).toHaveLength(3);
    expect(fs.readdirSync(root()).filter((f) => f.endsWith('.backup')).length).toBe(3);
  });
  it('recovers a journal whose rename completed before the manifest commit', async () => {
    await enable();
    const row = db.prepare('SELECT * FROM obsidian_exports').get() as {
      snapshot: string;
      filename: string;
    };
    const prior = JSON.parse(row.snapshot);
    const next = snapshot({ ...prior.data, title: 'Recovered' }, sync.owner);
    const before = fs.readFileSync(exported(), 'utf8'),
      after = mergeNote(before, prior, next);
    db.prepare('UPDATE obsidian_exports SET pending=?').run(
      JSON.stringify({ before, after, snapshot: next, revision: 999 }),
    );
    fs.writeFileSync(exported(), after);
    sync = make();
    await sync.run();
    expect(db.prepare('SELECT pending FROM obsidian_exports').get()).toEqual({ pending: null });
    expect(sync.status().issues).toEqual([]);
  });
  it('repairs an index hash interrupted after its file write', async () => {
    await enable();
    db.prepare("UPDATE obsidian_destinations SET browse_hash='old-hash'").run();
    sync.retry();
    await idle();
    meetings.updateTitle('one', 'After restart');
    await sync.run();
    expect(sync.status().error).toBeNull();
    expect(fs.readFileSync(path.join(root(), 'Browse.md'), 'utf8')).toContain('After restart');
  });
  it('refuses replacement when note identity was changed', async () => {
    await enable();
    const file = exported();
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('mn_id: one', 'mn_id: other'));
    meetings.updateTitle('one', 'Changed');
    await sync.run();
    expect(sync.compare('one').canReplace).toBe(false);
  });
  it('recovers a write interrupted before rename, but holds external changes across restarts', async () => {
    await enable();
    const row = db.prepare('SELECT snapshot FROM obsidian_exports').get() as { snapshot: string };
    const previous = JSON.parse(row.snapshot);
    const next = snapshot({ ...previous.data, title: 'Recovered' }, sync.owner);
    const before = fs.readFileSync(exported(), 'utf8');
    const pending = JSON.stringify({
      before,
      after: mergeNote(before, previous, next),
      snapshot: next,
      revision: 1,
    });
    db.prepare('UPDATE obsidian_exports SET pending=?').run(pending);
    sync = make();
    await sync.run();
    expect(sync.status().issues).toEqual([]);
    db.prepare('UPDATE obsidian_exports SET pending=?').run(pending);
    fs.appendFileSync(exported(), '\nNew external annotation');
    sync = make();
    await sync.run();
    expect(sync.status().issues[0]?.error).toContain('interrupted');
    expect(sync.status().pending).toBe(0);
    await sync.run();
    expect(fs.readFileSync(exported(), 'utf8')).toContain('New external annotation');
  });
  it('stops a yielded batch when disabled and rejects destination changes in flight', async () => {
    const p = sync.preview(opts());
    sync.enable(p.token);
    expect(sync.status().running).toBe(true);
    const other = sync.preview({ ...opts(), folder: 'Other' });
    expect(() => sync.enable(other.token)).toThrow('batch');
    sync.disable();
    await idle();
    expect(fs.readdirSync(path.join(root(), 'Notes'))).toHaveLength(0);
    sync.enable(sync.preview(opts()).token);
    await idle();
    expect(sync.status().synced).toBe(1);
  });
  it('rejects setup races, replaced vaults, and read-only destinations', async () => {
    const p = sync.preview(opts());
    fs.mkdirSync(root());
    fs.writeFileSync(path.join(root(), 'personal.md'), 'untouched');
    expect(() => sync.enable(p.token)).toThrow();
    expect(fs.readFileSync(path.join(root(), 'personal.md'), 'utf8')).toBe('untouched');
    fs.renameSync(root(), path.join(vault, 'Personal'));
    await enable();
    fs.chmodSync(root(), 0o500);
    meetings.updateTitle('one', 'Changed');
    await sync.run();
    expect(sync.status().error).toBeTruthy();
    fs.chmodSync(root(), 0o700);
    fs.renameSync(vault, `${vault}-original`);
    fs.mkdirSync(path.join(vault, '.obsidian'), { recursive: true });
    await sync.run();
    expect(sync.status().error).toContain('replaced');
    expect(fs.existsSync(root())).toBe(false);
  });
  it('flags duplicate identities when reconciling a rename', async () => {
    await enable();
    const content = fs.readFileSync(exported(), 'utf8');
    fs.unlinkSync(exported());
    fs.writeFileSync(path.join(root(), 'Notes', 'A.md'), content);
    fs.writeFileSync(path.join(root(), 'Notes', 'B.md'), content);
    meetings.updateTitle('one', 'Changed');
    await sync.run();
    expect(sync.status().issues[0]?.error).toContain('Multiple copies');
  });
  it('recovers a missing first summary with a meaningful filename', async () => {
    const summary = path.join(library, 'meetings', 'one', 'summary.md');
    fs.unlinkSync(summary);
    await enable();
    expect(sync.status().issues).toHaveLength(1);
    fs.writeFileSync(summary, 'Restored');
    sync.retry();
    await idle();
    expect(path.basename(exported())).toContain('Planning');
    expect(fs.readFileSync(exported(), 'utf8')).toContain('Restored');
  });
  it('bounds batches to 100, yields, catches up, and does not rewrite 500 unchanged notes', async () => {
    for (let i = 1; i < 500; i++) add(`fixture-${i}`, `Meeting ${i}`);
    const started = performance.now();
    await enable();
    expect(sync.status().synced).toBe(100);
    expect(sync.status().pending).toBe(400);
    for (let i = 0; i < 4; i++) await sync.run();
    expect(sync.status().synced).toBe(500);
    const writes = vi.spyOn(fs, 'renameSync');
    const unchanged = performance.now();
    await sync.run();
    expect(writes).not.toHaveBeenCalled();
    console.info(
      `Obsidian fixture: 500 exports ${(unchanged - started).toFixed(0)} ms; unchanged pass ${(performance.now() - unchanged).toFixed(1)} ms`,
    );
  });
  it('checks compare-before-write and never clobbers an unexpected file', () => {
    const file = path.join(vault, 'file.md');
    fs.writeFileSync(file, 'User data');
    expect(() => atomicWrite(vault, 'file.md', null, 'New')).toThrow();
    expect(fs.readFileSync(file, 'utf8')).toBe('User data');
  });
  it('tracks speaker changes and preserves unique files with duplicate unsafe titles', async () => {
    add('two', '../../🎉 Planning: [link]');
    add('three', '../../🎉 Planning: [link]');
    const speaker = speakers.create({ displayName: 'Alice' });
    db.prepare(
      'INSERT INTO meeting_speakers(meeting_id,local_label,roster_speaker_id) VALUES (?,?,?)',
    ).run('one', 'SPEAKER_00', speaker);
    await enable();
    db.prepare('UPDATE speakers SET display_name=? WHERE id=?').run('Alice Smith', speaker);
    await sync.run();
    expect(fs.readFileSync(exported(), 'utf8')).toContain('Alice Smith');
    expect(fs.readdirSync(path.join(root(), 'Notes'))).toHaveLength(3);
    expect(hash(fs.readFileSync(exported('two'), 'utf8'))).not.toBe(
      hash(fs.readFileSync(exported('three'), 'utf8')),
    );
  });
});

describe('managed Markdown', () => {
  const data: NoteData = {
    id: 'm',
    title: 'Title\nInjected: yaml',
    date: '2026-10-02T12:00:00Z',
    groupId: null,
    group: 'Ungrouped',
    duration: 0,
    participants: ['A: B'],
    openActions: 0,
    updated: 'now',
    deleted: false,
    stale: false,
    summary: 'Content',
    items: [],
  };
  it('round-trips YAML and retains trailing personal content and unknown arrays', () => {
    const before = snapshot(data, 'owner'),
      after = snapshot({ ...data, title: 'Changed' }, 'owner');
    const content =
      newNote(before).replace('---\n', '---\ntags: [personal, work]\n') + '\nPersonal text\n';
    const merged = mergeNote(content, before, after);
    expect(merged).toContain('Personal text');
    expect(merged).toContain('tags: [ personal, work ]');
  });
  it('rejects malformed markers or duplicate ownership keys', () => {
    const s = snapshot(data, 'owner');
    expect(() => mergeNote(newNote(s).replace('generated:end', 'missing'), s, s)).toThrow(
      'markers',
    );
    expect(() => mergeNote(newNote(s).replace('---\n', '---\nmn_id: other\n'), s, s)).toThrow(
      'invalid',
    );
  });
});
