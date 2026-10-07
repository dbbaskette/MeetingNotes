import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from './db.js';
import { MeetingsRepo } from './meetings-repo.js';
import { GroupsRepo } from './groups-repo.js';
import { ActionItemsRepo } from './action-items-repo.js';
import { SettingsRepo } from './settings-repo.js';
import { LibraryBackup, restoreLibraryBackup, validateBackup } from './library-backup.js';
import { assertNoLibraryMutations, beginLibraryMutation, backupIsLocked } from './backup-gate.js';
import { RecordingSessionsRepo } from './recording-sessions-repo.js';
import { searchScope } from '../search/facets.js';
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-243-')),
    library = path.join(root, 'relocated');
  fs.mkdirSync(library);
  const db = openDb(path.join(library, 'db.sqlite')),
    settingsDb = openDb(path.join(root, 'canonical.sqlite')),
    meetings = new MeetingsRepo(db),
    groups = new GroupsRepo(db),
    items = new ActionItemsRepo(db);
  const audio = path.join(root, 'outside.m4a');
  fs.writeFileSync(audio, 'synthetic audio');
  meetings.insert({
    id: 'm',
    slug: 'm',
    title: 'Synthetic',
    startedAt: '2026-10-05T12:00:00Z',
    durationS: 60,
    audioPath: audio,
    status: 'done',
    pipelineStage: 'done',
  });
  const folder = path.join(library, 'meetings', 'm');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'summary.md'), 'SLSA notes');
  fs.symlinkSync(audio, path.join(folder, 'audio.mp3'));
  return {
    root,
    library,
    db,
    settingsDb,
    meetings,
    groups,
    items,
    audio,
    close: () => {
      db.close();
      settingsDb.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
describe('Epic 243 data boundaries', () => {
  it('undoes only moved rows and rejects later moves, including ABA and removed destinations', () => {
    const f = fixture();
    try {
      const a = f.groups.create('A'),
        b = f.groups.create('B');
      f.groups.assign(['m'], a.id);
      const move = f.groups.assign(['m', 'missing'], b.id);
      expect(move.failedIds).toEqual(['missing']);
      f.groups.assign(['m'], a.id);
      f.groups.assign(['m'], b.id);
      expect(
        f.groups.undo(
          move.moved as { id: string; previousGroupId: string | null; revision: number }[],
        ).failedIds,
      ).toEqual(['m']);
      const latest = f.groups.assign(['m'], a.id);
      expect(
        f.groups.undo(
          latest.moved as { id: string; previousGroupId: string | null; revision: number }[],
        ).moved,
      ).toHaveLength(1);
      const back = f.groups.assign(['m'], a.id);
      f.groups.delete(b.id);
      expect(
        f.groups.undo(
          back.moved as { id: string; previousGroupId: string | null; revision: number }[],
        ).failedIds,
      ).toEqual(['m']);
    } finally {
      f.close();
    }
  });
  it('restores exact task identity/metadata and refuses to overwrite newer intent', () => {
    const f = fixture();
    try {
      const task = f.items.create('m', {
        text: 'SLSA follow-up',
        ownerName: 'Dan',
        dueDate: '2026-10-10',
      });
      f.items.setStatus(task.id, 'done');
      f.items.markExported(task.id, 'markdown');
      f.db
        .prepare('UPDATE action_items SET source_quote=? WHERE id=?')
        .run('Original source', task.id);
      const original = f.items.findById(task.id),
        token = f.items.deleteWithUndo(task.id)!;
      expect(f.items.undoDelete(token)).toBe(true);
      expect(f.items.findById(task.id)).toEqual(original);
      expect(f.items.undoDelete(token)).toBe(false);
      const stale = f.items.deleteWithUndo(task.id)!;
      f.items.create('m', { text: 'New intent' });
      expect(f.items.undoDelete(stale)).toBe(false);
      expect(f.items.findById(task.id)).toBeNull();
    } finally {
      f.close();
    }
  });
  it('applies facets in SQL before title result limits and excludes deleted meetings', () => {
    const f = fixture();
    try {
      for (let i = 0; i < 120; i++)
        f.meetings.insert({
          id: `x${i}`,
          slug: `x${i}`,
          title: 'Synthetic',
          startedAt: '2026-10-06T12:00:00Z',
          durationS: 60,
          audioPath: `/x${i}`,
          status: 'done',
          pipelineStage: 'done',
        });
      f.items.create('m', { text: 'Mine', ownerName: 'Dan' });
      const scope = searchScope({ actions: 'mine', week: '2026-W41' }, undefined, {
        id: null,
        name: 'Dan',
      });
      expect(
        f.meetings
          .facetedSearch()
          .titles('Synthetic', 20, scope)
          .map((row) => row.id),
      ).toEqual(['m']);
      f.meetings.softDelete('m');
      expect(f.meetings.facetedSearch().titles('Synthetic', 20, scope)).toEqual([]);
    } finally {
      f.close();
    }
  });
  it('backs up both actual databases and relocated audio, validates and restores into a new folder', async () => {
    const f = fixture();
    try {
      new SettingsRepo(f.settingsDb).set('libraryPath', f.library);
      new SettingsRepo(f.settingsDb).set('userName', 'Dan');
      fs.writeFileSync(f.audio.replace('.m4a', '.voice.m4a'), 'voice stem');
      fs.writeFileSync(f.audio.replace('.m4a', '.system.m4a'), 'system stem');
      const group = f.groups.create('Platform');
      f.groups.assign(['m'], group.id);
      f.items.create('m', { text: 'Preserved' });
      new RecordingSessionsRepo(f.db).insert({
        id: 'r',
        helperPid: -1,
        targetPid: null,
        targetLabel: 'Zoom',
        outputPath: f.audio,
        title: 'Optional title',
      });
      const backup = new LibraryBackup({
          db: f.db,
          settingsDb: f.settingsDb,
          root: f.library,
          version: '1.14.0',
          assertIdle: assertNoLibraryMutations,
          pause: () => () => {},
        }),
        preview = await backup.preview(f.root);
      const status = await backup.run(preview.destination);
      expect(status.state).toBe('complete');
      expect(backupIsLocked()).toBe(false);
      const manifest = await validateBackup(preview.destination);
      expect(manifest.paths.some((mapping) => mapping.original === f.audio)).toBe(true);
      const restored = path.join(f.root, 'restored');
      await restoreLibraryBackup(preview.destination, restored);
      const db = openDb(path.join(restored, 'library', 'db.sqlite'));
      try {
        const row = new MeetingsRepo(db).findById('m')!;
        expect(row.groupId).toBe(group.id);
        expect(fs.readFileSync(row.audioPath, 'utf8')).toBe('synthetic audio');
        expect(fs.readFileSync(row.audioPath.replace('.m4a', '.voice.m4a'), 'utf8')).toBe(
          'voice stem',
        );
        expect(fs.readFileSync(row.audioPath.replace('.m4a', '.system.m4a'), 'utf8')).toBe(
          'system stem',
        );
        expect(
          fs.readFileSync(path.join(restored, 'library', 'meetings', 'm', 'audio.mp3'), 'utf8'),
        ).toBe('synthetic audio');
        expect(new ActionItemsRepo(db).listByMeeting('m')[0]?.text).toBe('Preserved');
      } finally {
        db.close();
      }
      await expect(restoreLibraryBackup(preview.destination, restored)).rejects.toThrow(/new/);
      expect(new SettingsRepo(f.settingsDb).get('libraryPath')).toBe(f.library);
      expect(fs.readFileSync(f.audio, 'utf8')).toBe('synthetic audio');
      fs.writeFileSync(
        path.join(preview.destination, 'library', 'meetings', 'm', 'summary.md'),
        'tampered',
      );
      await expect(validateBackup(preview.destination)).rejects.toThrow(/validation/);
    } finally {
      f.close();
    }
  });
  it('rejects active work, changed files and unsafe destinations without changing originals', async () => {
    const f = fixture();
    try {
      const backup = new LibraryBackup({
        db: f.db,
        settingsDb: f.settingsDb,
        root: f.library,
        version: '1.14.0',
        assertIdle: assertNoLibraryMutations,
        pause: () => () => {},
      });
      await expect(backup.preview(f.library)).rejects.toThrow(/outside/);
      const preview = await backup.preview(f.root),
        finish = beginLibraryMutation();
      await expect(backup.run(preview.destination)).rejects.toThrow(/saving/);
      finish();
      fs.writeFileSync(f.audio, 'a changed external recording');
      expect((await backup.run(preview.destination)).state).toBe('failed');
      expect(fs.existsSync(path.join(preview.destination, 'INCOMPLETE'))).toBe(true);
      expect(backupIsLocked()).toBe(false);
      expect(fs.readFileSync(f.audio, 'utf8')).toBe('a changed external recording');
      await expect(
        restoreLibraryBackup(preview.destination, path.join(f.root, 'invalid')),
      ).rejects.toThrow(/incomplete/);
    } finally {
      f.close();
    }
  });
});
