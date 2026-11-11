import fs from 'node:fs';
import path from 'node:path';

/** The formats the library watcher catalogs. Importing anything else would
 *  report success for a file that never becomes a meeting. */
export const IMPORTABLE_AUDIO_EXTENSIONS = ['.m4a', '.mp3'] as const;

export interface ImportResult { imported: number; skipped: { path: string; reason: string }[] }

/** Copy dropped audio files into `destDir` (a folder the watcher catalogs).
 *  Copies run off the main thread's event loop so a large file cannot freeze
 *  the window. An existing name is never overwritten. */
export async function importAudioFiles(paths: readonly string[], destDir: string, now: () => Date = () => new Date()): Promise<ImportResult> {
  await fs.promises.mkdir(destDir, { recursive: true });
  const result: ImportResult = { imported: 0, skipped: [] };
  for (const src of paths) {
    try {
      const ext = path.extname(src).toLowerCase();
      if (!(IMPORTABLE_AUDIO_EXTENSIONS as readonly string[]).includes(ext)) {
        result.skipped.push({ path: src, reason: `unsupported format ${ext || '(none)'}` });
        continue;
      }
      const stat = await fs.promises.stat(src).catch(() => null);
      if (!stat?.isFile()) { result.skipped.push({ path: src, reason: 'not a file' }); continue; }
      const base = path.basename(src);
      let dest = path.join(destDir, base);
      if (fs.existsSync(dest)) {
        const stamp = now().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        dest = path.join(destDir, `${path.basename(base, path.extname(base))}-${stamp}${ext}`);
      }
      // COPYFILE_EXCL: lose a race for the name rather than replace a recording.
      await fs.promises.copyFile(src, dest, fs.constants.COPYFILE_EXCL);
      result.imported += 1;
    } catch (error) {
      result.skipped.push({ path: src, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}
