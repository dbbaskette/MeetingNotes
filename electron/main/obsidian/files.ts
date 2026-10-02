import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
export function identity(file: string): string {
  const s = fs.lstatSync(file);
  if (!s.isDirectory() || s.isSymbolicLink())
    throw new Error('Expected an existing folder, not a symbolic link');
  return `${s.dev}:${s.ino}`;
}
export function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}
export function validateVault(input: string, library: string): string {
  if (!path.isAbsolute(input))
    throw new Error('Choose the absolute path to an existing Obsidian vault');
  const vault = fs.realpathSync(input);
  identity(vault);
  identity(path.join(vault, '.obsidian'));
  const source = fs.realpathSync(library);
  if (inside(source, vault) || inside(vault, source))
    throw new Error('The vault and MeetingNotes library must be separate folders');
  fs.accessSync(vault, fs.constants.R_OK | fs.constants.W_OK);
  return vault;
}
export function safePath(root: string, relative: string): string {
  const result = path.resolve(root, relative);
  if (!inside(root, result) || result === root) throw new Error('Unsafe vault path');
  let current = root;
  identity(root);
  for (const part of path.relative(root, result).split(path.sep)) {
    current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink())
        throw new Error('Symbolic links are not supported in the sync folder');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }
  return result;
}
export function readText(file: string): string | null {
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  try {
    const s = fs.fstatSync(fd);
    if (!s.isFile() || s.size > 12_000_000)
      throw new Error('Not a regular text file or file exceeds the 12 MB safety limit');
    return fs.readFileSync(fd, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
}
/** Caller journals before/after first. No overwrite of an unexpected revision. */
export function atomicWrite(
  root: string,
  relative: string,
  before: string | null,
  after: string,
): void {
  const file = safePath(root, relative);
  if (readText(file) !== before)
    throw new Error('File changed during sync; retry after reviewing the note');
  const temp = safePath(root, `${relative}.${randomUUID()}.tmp`);
  const fd = fs.openSync(temp, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, after);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    safePath(root, relative);
    if (readText(file) !== before) throw new Error('File changed during sync; nothing replaced');
    if (before === null) {
      fs.linkSync(temp, file);
      fs.unlinkSync(temp);
    } else fs.renameSync(temp, file);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}
