// electron/main/pipeline/transcript-chars.ts
import fs from 'node:fs';
import path from 'node:path';
import { meetingFolderPath } from '../storage/meeting-folder.js';

/** Char count of transcript.md for a meeting, or 0 if it doesn't exist yet.
 *  The size proxy for the learned ETA's bucket. Media stages that run before
 *  merge writes transcript.md fall to 0 (bucket 0) on a first pass — accepted
 *  in the design; refined as larger meetings accumulate samples. */
export function transcriptChars(libraryRoot: string, slug: string): number {
  const p = path.join(meetingFolderPath(libraryRoot, slug), 'transcript.md');
  try {
    return fs.existsSync(p) ? fs.statSync(p).size : 0;
  } catch {
    return 0;
  }
}
