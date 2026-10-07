import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Prefer literal filenames. Only interpret paste syntax if the literal path
 * doesn't exist and the corrected, absolute directory can be verified. */
export function existingFolder(input: string): string {
  const literal = input;
  const trimmed = input.trim();
  const unquoted = /^(["']).*\1$/.test(trimmed) ? trimmed.slice(1, -1) : trimmed;
  const expanded = unquoted.startsWith('~/') ? path.join(os.homedir(), unquoted.slice(2)) : unquoted;
  const candidates = [...new Set([literal, trimmed, expanded, expanded.replace(/\\([\s\\"'()])/g, '$1')])];
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate)) continue;
    try {
      const resolved = fs.realpathSync(candidate);
      if (fs.statSync(resolved).isDirectory()) return resolved;
    } catch (e) {
      if (!['ENOENT', 'ENOTDIR'].includes((e as NodeJS.ErrnoException).code ?? ''))
        throw new Error('This folder cannot be accessed. Check permissions or choose another folder.');
    }
  }
  throw new Error('Folder not found. Check that it is available, or use Choose folder to select it.');
}
