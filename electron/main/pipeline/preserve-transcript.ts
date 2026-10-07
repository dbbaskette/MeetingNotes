import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** Preserve manual transcript edits before stages that replace them. Notes and
 * action items have their existing history UI; transcript snapshots remain in
 * the meeting folder (Finder) and are listed in technical retry history. */
export function preserveTranscript(folder: string, stage: string): string | null {
  if (!['transcribing', 'diarizing', 'merging'].includes(stage)) return null;
  const source = path.join(folder, 'transcript.md');
  if (!fs.existsSync(source)) return null;
  const name = `transcript.before-rerun-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.md`;
  fs.copyFileSync(source, path.join(folder, name), fs.constants.COPYFILE_EXCL);
  return name;
}
