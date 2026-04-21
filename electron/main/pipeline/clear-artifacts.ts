import fs from 'node:fs';
import path from 'node:path';

// Artifacts each stage produces, in pipeline order. Clearing FROM a stage
// deletes that stage's output + everything downstream, so a retry doesn't
// show stale text (the "Do I have to create a new one?" loop hanging around
// in transcript.raw.json until a new transcribe finishes, etc.) and doesn't
// accidentally serve a half-stale mixture (old transcript.md + new summary).
const STAGE_ARTIFACTS: Record<string, readonly string[]> = {
  transcribing: ['transcript.raw.json', 'diarization.json', 'transcript.md', 'summary.md', 'action-items.json'],
  diarizing:    ['diarization.json', 'transcript.md', 'summary.md', 'action-items.json'],
  merging:      ['transcript.md', 'summary.md', 'action-items.json'],
  identifying:  ['summary.md', 'action-items.json'],
  summarizing:  ['summary.md', 'action-items.json'],
  extracting:   ['action-items.json'],
};

export function clearArtifactsFromStage(folder: string, fromStage: string): void {
  const files = STAGE_ARTIFACTS[fromStage];
  if (!files) return;
  for (const name of files) {
    const p = path.join(folder, name);
    try {
      fs.rmSync(p, { force: true });
    } catch {
      /* ignore — missing is fine */
    }
  }
}

/** Stages where retrying should also drop per-meeting DB rows (action items,
 *  speaker links). Kept separate from file cleanup so the repos can run
 *  inside the existing transaction context. */
export function shouldClearActionItems(fromStage: string): boolean {
  // Anything that changes the transcript or its downstream analysis wipes
  // the old action items. Extracting re-runs also replace them, but clearing
  // up front makes the UI state consistent during the retry.
  return fromStage in STAGE_ARTIFACTS;
}

export function shouldClearSpeakerLinks(fromStage: string): boolean {
  // Speaker identification happens after diarize. Any rerun that invalidates
  // diarization output invalidates the speaker links too.
  return fromStage === 'transcribing' || fromStage === 'diarizing' || fromStage === 'identifying';
}
