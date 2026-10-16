import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import type { BetaPreview } from '../../shared/speech-beta.js';

export function within(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
export function ownedPath(root: string, ...parts: string[]): string {
  const target = path.resolve(root, ...parts);
  if (!within(root, target)) throw new Error('Path is outside the beta library.');
  let current = target;
  while (within(root, current)) {
    try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Beta data cannot use symbolic links.'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (current === root) break;
    current = path.dirname(current);
  }
  return target;
}
interface Entry { source: string; relative: string; size: number; modified: number; }
interface Inventory { entries: Entry[]; missing: number; paths: Map<string, string>; }
function sourceDb(root: string): Database.Database {
  // Never call openDb: that sets WAL pragmas and runs application migrations.
  return new Database(path.join(root, 'db.sqlite'), { readonly: true, fileMustExist: true });
}
function signature(value: Inventory): string {
  return JSON.stringify(value.entries.map(e => [e.source, e.relative, e.size, e.modified]).sort());
}
async function inventory(root: string): Promise<Inventory> {
  const entries: Entry[] = [], paths = new Map<string, string>(); let missing = 0;
  const walk = async (directory: string, relative = ''): Promise<void> => {
    for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
      if (!relative && /^(db\.sqlite(?:-wal|-shm)?|whisper-models|\.cache|\.beta-.*)$/.test(entry.name)) continue;
      const source = path.join(directory, entry.name), target = path.join(relative, entry.name);
      if (entry.isDirectory()) { await walk(source, target); continue; }
      try {
        const resolved = await fs.promises.realpath(source), stat = await fs.promises.stat(resolved);
        if (!stat.isFile()) { missing++; continue; }
        entries.push({ source: resolved, relative: target, size: stat.size, modified: stat.mtimeMs });
        paths.set(source, target); paths.set(resolved, target);
      } catch { missing++; }
    }
  };
  await walk(root);
  const db = sourceDb(root);
  try {
    const audio = db.prepare('SELECT audio_path AS file FROM meetings UNION SELECT output_path AS file FROM recording_sessions').all() as { file: string }[];
    for (const { file } of audio) {
      if (paths.has(file)) continue;
      try {
        const resolved = await fs.promises.realpath(file), stat = await fs.promises.stat(resolved);
        if (!stat.isFile()) { missing++; continue; }
        const relative = paths.get(resolved) ?? path.join('external-audio', `${createHash('sha256').update(resolved).digest('hex').slice(0, 16)}-${path.basename(resolved)}`);
        if (!paths.has(resolved)) entries.push({ source: resolved, relative, size: stat.size, modified: stat.mtimeMs });
        paths.set(file, relative); paths.set(resolved, relative);
      } catch { missing++; }
    }
  } finally { db.close(); }
  return { entries, missing, paths };
}
function assertIdle(db: Database.Database): void {
  const active = db.prepare("SELECT 1 FROM recording_sessions WHERE status IN ('recording','starting','stopping') LIMIT 1").get();
  const processing = db.prepare("SELECT 1 FROM meetings WHERE status = 'processing' LIMIT 1").get();
  if (active || processing) throw new Error('Finish recording and processing in MeetingNotes, then close it before copying. Nothing was interrupted.');
}
export class BetaLibraryImport {
  private prepared: { preview: BetaPreview; inventory: Inventory; dataVersion: number } | null = null;
  constructor(private readonly profile: string) {}
  get destination(): string { return ownedPath(this.profile, 'library'); }
  async preview(selectedRoot: string): Promise<BetaPreview> {
    const root = await fs.promises.realpath(selectedRoot);
    if (within(root, this.profile) || within(this.profile, root)) throw new Error('Choose the original library, outside the beta data folder.');
    if (fs.existsSync(this.destination)) throw new Error('A beta library already exists. It will not be overwritten.');
    const db = sourceDb(root);
    let dataVersion: number;
    try { assertIdle(db); dataVersion = db.pragma('data_version', { simple: true }) as number; }
    finally { db.close(); }
    const files = await inventory(root);
    const preview = { source: root, destination: this.destination,
      bytes: files.entries.reduce((n, entry) => n + entry.size, fs.statSync(path.join(root, 'db.sqlite')).size),
      files: files.entries.length + 1, missing: files.missing };
    this.prepared = { preview, inventory: files, dataVersion };
    return preview;
  }
  async run(signal: AbortSignal, progress: (fraction: number) => void): Promise<void> {
    const prepared = this.prepared; this.prepared = null;
    if (!prepared) throw new Error('Preview the library copy first.');
    const { preview, inventory: initial } = prepared;
    if (fs.existsSync(this.destination)) throw new Error('A beta library already exists; it was not overwritten.');
    if (signature(await inventory(preview.source)) !== signature(initial)) throw new Error('The source library changed. Preview the copy again.');
    const disk = fs.statfsSync(this.profile);
    if (disk.bavail * disk.bsize < preview.bytes + 1024 ** 3) throw new Error('Not enough space for a safe library copy. Free space and preview again.');
    const stage = ownedPath(this.profile, `.library-copy-${randomUUID()}`);
    fs.mkdirSync(stage, { mode: 0o700 });
    const source = sourceDb(preview.source);
    try {
      assertIdle(source);
      const dataVersion = source.pragma('data_version', { simple: true });
      await source.backup(path.join(stage, 'db.sqlite'));
      let completed = 0;
      for (const entry of initial.entries) {
        signal.throwIfAborted();
        const before = fs.statSync(entry.source);
        if (before.size !== entry.size || before.mtimeMs !== entry.modified) throw new Error('A source file changed. Close MeetingNotes and try again.');
        const target = ownedPath(stage, entry.relative);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        await fs.promises.copyFile(entry.source, target, fs.constants.COPYFILE_FICLONE);
        completed += entry.size; progress(completed / Math.max(1, preview.bytes));
      }
      assertIdle(source);
      if (source.pragma('data_version', { simple: true }) !== dataVersion || signature(await inventory(preview.source)) !== signature(initial)) {
        throw new Error('The source library changed during copying. Close MeetingNotes and try again.');
      }
      signal.throwIfAborted();
      const copy = new Database(path.join(stage, 'db.sqlite'));
      try {
        const rewrite = (file: string): string => {
          const relative = initial.paths.get(file);
          // Missing audio is deliberately beta-owned/unavailable, not a live stable path.
          return path.join(this.destination, relative ?? path.join('unavailable-audio', createHash('sha256').update(file).digest('hex') + path.extname(file)));
        };
        copy.transaction(() => {
          // Never copy credentials, export destinations, watcher roots, or recording triggers as active settings.
          copy.prepare('DELETE FROM settings').run();
          for (const row of copy.prepare('SELECT id, audio_path FROM meetings').all() as { id: string; audio_path: string }[]) {
            copy.prepare('UPDATE meetings SET audio_path = ? WHERE id = ?').run(rewrite(row.audio_path), row.id);
          }
          for (const row of copy.prepare('SELECT id, output_path FROM recording_sessions').all() as { id: string; output_path: string }[]) {
            copy.prepare('UPDATE recording_sessions SET output_path = ? WHERE id = ?').run(rewrite(row.output_path), row.id);
          }
        })();
        // DELETE alone can leave encrypted/plaintext settings in free pages.
        copy.exec('VACUUM');
        if (copy.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('The copied database failed its integrity check.');
      } finally { copy.close(); }
      fs.writeFileSync(path.join(stage, 'beta-snapshot.json'), JSON.stringify({ version: 1, copiedAt: new Date().toISOString(), missing: preview.missing }));
      // Publish only a complete copy. No code in the beta opens the stable database for writes.
      fs.renameSync(stage, this.destination); progress(1);
    } finally {
      source.close(); fs.rmSync(stage, { recursive: true, force: true });
    }
  }
}
