import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import type { BackupManifest, BackupPreview, BackupStatus } from '../../shared/backup.js';
import { acquireBackup } from './backup-gate.js';
interface FileEntry {
  source: string;
  relative: string;
  bytes: number;
  modified: number;
}
interface Inventory {
  entries: FileEntry[];
  links: { path: string; source: string }[];
  missing: string[];
}
function inventorySignature(inventory: Inventory): string {
  return JSON.stringify({
    entries: [...inventory.entries].sort((a, b) => a.relative.localeCompare(b.relative)),
    links: [...inventory.links].sort((a, b) => a.path.localeCompare(b.path)),
    missing: [...new Set(inventory.missing)].sort(),
  });
}
async function digest(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
function within(root: string, file: string): boolean {
  const rel = path.relative(root, file);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}
export class LibraryBackup {
  status: BackupStatus = { state: 'idle', completed: 0, total: 0 };
  private previewed: {
    preview: BackupPreview;
    entries: FileEntry[];
    links: { path: string; source: string }[];
  } | null = null;
  constructor(
    private deps: {
      db: Database.Database;
      settingsDb: Database.Database;
      root: string;
      version: string;
      assertIdle: () => void;
      pause: () => () => void;
    },
  ) {}
  async preview(parent: string): Promise<BackupPreview> {
    this.deps.assertIdle();
    const canonical = await fs.promises.realpath(parent),
      root = await fs.promises.realpath(this.deps.root);
    if (within(root, canonical))
      throw new Error('Choose a backup destination outside the Library.');
    const destination = path.join(
      canonical,
      `MeetingNotes-backup-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`,
    );
    const { entries, links, missing } = await this.inventory(root);
    const preview = {
      destination,
      bytes:
        entries.reduce((sum, entry) => sum + entry.bytes, 0) +
        fs.statSync(this.deps.db.name).size +
        fs.statSync(this.deps.settingsDb.name).size,
      files: entries.length + 2,
      missing: [...new Set(missing)],
    };
    this.previewed = { preview, entries, links };
    return preview;
  }
  private async inventory(root: string): Promise<Inventory> {
    const entries: FileEntry[] = [],
      links: { path: string; source: string }[] = [],
      missing: string[] = [];
    const add = async (source: string, relative: string): Promise<void> => {
      try {
        const stat = await fs.promises.stat(source);
        if (!stat.isFile()) throw new Error('not a regular file');
        entries.push({ source, relative, bytes: stat.size, modified: stat.mtimeMs });
      } catch {
        missing.push(source);
      }
    };
    const walk = async (directory: string, relative: string): Promise<void> => {
      for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
        if (
          relative === 'library' &&
          /^(db\.sqlite(?:-wal|-shm)?|whisper-models|\.cache)$/.test(entry.name)
        )
          continue;
        const source = path.join(directory, entry.name),
          target = path.posix.join(relative, entry.name);
        if (entry.isDirectory()) await walk(source, target);
        else if (entry.isSymbolicLink()) {
          try {
            const resolved = await fs.promises.realpath(source);
            const stat = await fs.promises.stat(resolved);
            if (!stat.isFile()) throw new Error('directory symlink');
            links.push({ path: target, source: resolved });
          } catch {
            missing.push(source);
          }
        } else if (entry.isFile()) await add(source, target);
      }
    };
    await walk(root, 'library');
    const audio = this.deps.db
      .prepare(
        'SELECT audio_path AS file FROM meetings UNION SELECT output_path AS file FROM recording_sessions',
      )
      .all() as { file: string }[];
    const stems = audio.flatMap(({ file }) =>
      /\.m4a$/i.test(file)
        ? ['.voice.m4a', '.system.m4a']
            .map((suffix) => ({ file: file.replace(/\.m4a$/i, suffix) }))
            .filter((item) => fs.existsSync(item.file))
        : [],
    );
    const stemBases = new Map(
      stems.map(({ file }) => [file, file.replace(/\.(voice|system)\.m4a$/i, '.m4a')]),
    );
    for (const item of [...audio, ...stems, ...links.map((link) => ({ file: link.source }))]) {
      let resolved: string;
      try {
        resolved = await fs.promises.realpath(item.file);
      } catch {
        missing.push(item.file);
        continue;
      }
      if (entries.some((entry) => entry.source === resolved)) continue;
      const relative = within(root, resolved)
        ? path.posix.join('library', path.relative(root, resolved).split(path.sep).join('/'))
        : path.posix.join(
            'library',
            'external-audio',
            createHash('sha256')
              .update(
                stemBases.get(item.file)
                  ? await fs.promises.realpath(stemBases.get(item.file)!)
                  : resolved,
              )
              .digest('hex')
              .slice(0, 16) +
              '-' +
              path.basename(resolved),
          );
      await add(resolved, relative);
    }
    return { entries, links, missing };
  }
  async run(destination: string): Promise<BackupStatus> {
    if (!this.previewed || destination !== this.previewed.preview.destination)
      throw new Error('Preview the backup destination first.');
    this.deps.assertIdle();
    const release = acquireBackup();
    let resume: () => void;
    try {
      resume = this.deps.pause();
    } catch (error) {
      release();
      throw error;
    }
    const { preview, entries, links } = this.previewed;
    this.previewed = null;
    this.status = { state: 'working', completed: 0, total: preview.files, destination };
    try {
      if (preview.missing.length)
        throw new Error(
          `Cannot create a complete backup: ${preview.missing.length} referenced files are missing or unsupported. Locate them before retrying.`,
        );
      await fs.promises.mkdir(destination, { recursive: false, mode: 0o700 });
      await fs.promises.mkdir(path.join(destination, 'library'));
      await fs.promises.writeFile(
        path.join(destination, 'INCOMPLETE'),
        'Backup is not validated yet. Do not restore.\n',
        { flag: 'wx' },
      );
      // Preview is not a lock. Recheck under the write lock so newly added
      // recordings, notes, stems or references cannot silently be omitted.
      const current = await this.inventory(await fs.promises.realpath(this.deps.root));
      if (
        inventorySignature(current) !==
        inventorySignature({ entries, links, missing: preview.missing })
      )
        throw new Error('The Library changed after preview. Preview again before backing up.');
      await this.deps.db.backup(path.join(destination, 'library', 'db.sqlite'));
      this.status.completed++;
      await this.deps.settingsDb.backup(path.join(destination, 'settings.sqlite'));
      this.status.completed++;
      const paths = new Map<string, string>();
      for (const entry of entries) {
        const before = await fs.promises.stat(entry.source);
        if (before.size !== entry.bytes || before.mtimeMs !== entry.modified)
          throw new Error(
            `A source file changed after preview: ${entry.source}. Retry when writes have finished.`,
          );
        const target = path.join(destination, entry.relative);
        await fs.promises.mkdir(path.dirname(target), { recursive: true });
        await fs.promises.copyFile(entry.source, target, fs.constants.COPYFILE_EXCL);
        const after = await fs.promises.stat(entry.source);
        if (after.size !== before.size || after.mtimeMs !== before.mtimeMs)
          throw new Error(`A source file changed while copying: ${entry.source}.`);
        paths.set(entry.source, entry.relative);
        this.status.completed++;
      }
      // Preserve raw path aliases as well as canonical ones for relocated audio.
      for (const row of this.deps.db
        .prepare(
          'SELECT audio_path AS file FROM meetings UNION SELECT output_path AS file FROM recording_sessions',
        )
        .all() as { file: string }[]) {
        const canonical = await fs.promises.realpath(row.file);
        const relative = paths.get(canonical);
        if (!relative) throw new Error(`A referenced audio file was not copied: ${row.file}.`);
        paths.set(row.file, relative);
      }
      const portableLinks = links.map((link) => {
        const target = paths.get(link.source);
        if (!target) throw new Error(`Unresolved audio link ${link.path}`);
        return { path: link.path, target };
      });
      for (const link of portableLinks) {
        const target = path.join(destination, link.path);
        await fs.promises.mkdir(path.dirname(target), { recursive: true });
        await fs.promises.symlink(
          path.relative(path.dirname(target), path.join(destination, link.target)),
          target,
        );
      }
      const files: BackupManifest['files'] = [];
      for (const relative of [
        'library/db.sqlite',
        'settings.sqlite',
        ...entries.map((entry) => entry.relative),
      ]) {
        const file = path.join(destination, relative);
        files.push({
          path: relative,
          bytes: (await fs.promises.stat(file)).size,
          sha256: await digest(file),
        });
      }
      const manifest: BackupManifest = {
        format: 1,
        createdAt: new Date().toISOString(),
        version: this.deps.version,
        libraryRoot: this.deps.root,
        settingsDatabase: this.deps.settingsDb.name,
        files,
        paths: [...paths].map(([original, relative]) => ({ original, relative })),
        links: portableLinks,
      };
      await fs.promises.writeFile(
        path.join(destination, 'manifest.json'),
        JSON.stringify(manifest, null, 2),
        { flag: 'wx' },
      );
      await validateBackup(destination);
      await fs.promises.writeFile(
        path.join(destination, 'RESTORE.md'),
        '# Restore safely\n\nQuit MeetingNotes. Keep the original library untouched. Validate this manifest and restore to a NEW empty folder using the repository restore-library-backup script. It rebases audio references and both database copies. Follow docs/library-backup.md to select the restored Library and restore canonical settings separately. Never overwrite an active library.\n\nThis backup contains meeting audio, names, notes, settings (possibly webhook secrets), and original paths. Store it privately; nothing was uploaded. Model caches are not needed and can be downloaded again.\n',
        { flag: 'wx' },
      );
      await fs.promises.unlink(path.join(destination, 'INCOMPLETE'));
      this.status = { ...this.status, state: 'complete' };
    } catch (error) {
      this.status = {
        ...this.status,
        state: 'failed',
        error: `${(error as Error).message} Original files are unchanged. Any incomplete backup remains at ${destination}.`,
      };
    } finally {
      release();
      resume();
    }
    return this.status;
  }
}
export async function validateBackup(root: string): Promise<BackupManifest> {
  const manifest = JSON.parse(
    await fs.promises.readFile(path.join(root, 'manifest.json'), 'utf8'),
  ) as BackupManifest;
  if (
    manifest.format !== 1 ||
    !Array.isArray(manifest.files) ||
    !Array.isArray(manifest.paths) ||
    !Array.isArray(manifest.links)
  )
    throw new Error('Unsupported backup manifest.');
  const safe = (relative: string): string => {
    if (
      typeof relative !== 'string' ||
      path.isAbsolute(relative) ||
      !within(root, path.resolve(root, relative))
    )
      throw new Error('Unsafe backup path.');
    return path.join(root, relative);
  };
  const seen = new Set<string>();
  const canonicalRoot = await fs.promises.realpath(root);
  for (const file of manifest.files) {
    if (seen.has(file.path)) throw new Error('Duplicate backup file.');
    seen.add(file.path);
    const target = safe(file.path);
    const stat = await fs.promises.lstat(target);
    if (
      !stat.isFile() ||
      !within(canonicalRoot, await fs.promises.realpath(target)) ||
      stat.size !== file.bytes ||
      (await digest(target)) !== file.sha256
    )
      throw new Error(`Backup file failed validation: ${file.path}`);
  }
  if (!seen.has('library/db.sqlite') || !seen.has('settings.sqlite'))
    throw new Error('Backup databases are missing.');
  for (const mapping of manifest.paths)
    if (typeof mapping.original !== 'string' || !seen.has(mapping.relative))
      throw new Error('Invalid backup audio mapping.');
  for (const link of manifest.links) {
    const target = safe(link.path);
    if (
      !seen.has(link.target) ||
      !within(root, await fs.promises.realpath(target)) ||
      (await fs.promises.realpath(target)) !== (await fs.promises.realpath(safe(link.target)))
    )
      throw new Error('Invalid backup link.');
  }
  for (const relative of ['library/db.sqlite', 'settings.sqlite']) {
    const db = new Database(safe(relative), { readonly: true, fileMustExist: true });
    try {
      if (db.pragma('integrity_check', { simple: true }) !== 'ok')
        throw new Error('Backup database failed integrity check.');
      if (relative === 'library/db.sqlite') {
        const mapped = new Set(manifest.paths.map((mapping) => mapping.original));
        for (const row of db
          .prepare(
            'SELECT audio_path AS file FROM meetings UNION SELECT output_path AS file FROM recording_sessions',
          )
          .all() as { file: string }[])
          if (!mapped.has(row.file))
            throw new Error('Backup is missing a referenced audio mapping.');
      }
    } finally {
      db.close();
    }
  }
  return manifest;
}
/** Disposable or explicitly chosen NEW destination only; originals never change. */
export async function restoreLibraryBackup(backup: string, destination: string): Promise<void> {
  if (fs.existsSync(path.join(backup, 'INCOMPLETE')))
    throw new Error('Cannot restore an incomplete backup.');
  const manifest = await validateBackup(backup);
  if (fs.existsSync(destination))
    throw new Error('Restore requires a new, nonexistent destination.');
  await fs.promises.mkdir(destination, { recursive: false });
  for (const file of manifest.files) {
    const target = path.join(destination, file.path);
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.copyFile(path.join(backup, file.path), target, fs.constants.COPYFILE_EXCL);
  }
  for (const link of manifest.links) {
    const target = path.join(destination, link.path);
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.symlink(
      path.relative(path.dirname(target), path.join(destination, link.target)),
      target,
    );
  }
  const root = path.join(destination, 'library'),
    db = new Database(path.join(root, 'db.sqlite'));
  try {
    db.transaction(() => {
      for (const mapping of manifest.paths) {
        const target = path.join(destination, mapping.relative);
        db.prepare('UPDATE meetings SET audio_path=? WHERE audio_path=?').run(
          target,
          mapping.original,
        );
        db.prepare('UPDATE recording_sessions SET output_path=? WHERE output_path=?').run(
          target,
          mapping.original,
        );
      }
      db.prepare(
        "INSERT INTO settings(key,value) VALUES ('libraryPath',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      ).run(JSON.stringify(root));
    })();
  } finally {
    db.close();
  }
  const settings = new Database(path.join(destination, 'settings.sqlite'));
  try {
    settings
      .prepare(
        "INSERT INTO settings(key,value) VALUES ('libraryPath',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(JSON.stringify(root));
  } finally {
    settings.close();
  }
}
