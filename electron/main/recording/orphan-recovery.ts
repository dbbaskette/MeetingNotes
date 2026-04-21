import type { RecordingSessionsRepo } from '../storage/recording-sessions-repo.js';

export interface RecoverDeps {
  repo: RecordingSessionsRepo;
  isProcessAlive?: (pid: number) => boolean;
}

/**
 * Called once at app launch. Scans recording_sessions for open rows whose
 * helper PID is dead. Those are real orphans (parent died, helper exited
 * via parent-watch); their files are on disk and the LibraryWatcher will
 * pick them up. We just update DB status so future scans don't re-process.
 */
export async function recoverOrphans(deps: RecoverDeps): Promise<void> {
  const isAlive = deps.isProcessAlive ?? defaultIsAlive;
  for (const row of deps.repo.findOpen()) {
    if (!isAlive(row.helperPid)) {
      deps.repo.markOrphaned(row.id);
    }
    // If the helper is somehow still alive, don't touch — let it finish.
  }
}

function defaultIsAlive(pid: number): boolean {
  try {
    // Signal 0 doesn't actually send anything but errors if process is gone.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
