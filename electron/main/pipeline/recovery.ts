import type { MeetingsRepo } from '../storage/meetings-repo.js';
import type { Logger } from '../logging/logger.js';
import { previousCompletedOnCrash, type Stage } from '../lib/stage-machine.js';

export interface RecoveryDeps {
  meetings: MeetingsRepo;
  /** Used by the legacy auto-resume code path. Kept in the signature
   *  so existing call sites don't need a change, but currently unused
   *  — recovery now leaves crashed meetings in 'pending' for the
   *  user to explicitly restart. */
  enqueue: (meetingId: string) => void;
  logger: Logger;
}

/** On launch, find any meeting that was mid-pipeline when the app
 *  exited last time (`status='processing'`) and roll it back to a
 *  safe re-entry stage + 'pending' status. We deliberately do NOT
 *  auto-enqueue — early users were surprised by recordings starting
 *  to process the moment they reopened the app, especially when
 *  they'd just dropped in a batch of files and wanted to control
 *  what runs first. The library's filter chips and Pending-row
 *  Process buttons are the explicit re-entry point. */
export function recoverPendingMeetings(deps: RecoveryDeps): void {
  // The signature accepts `enqueue` to preserve backwards-compat with
  // the test seam, but we don't call it any more. Reference it once
  // to satisfy strict-unused-args lints without changing the API.
  void deps.enqueue;
  for (const m of deps.meetings.findResumable()) {
    const rolled = previousCompletedOnCrash(m.pipelineStage as Stage);
    if (rolled !== m.pipelineStage) deps.meetings.updateStage(m.id, rolled);
    deps.meetings.updateStatus(m.id, 'pending');
    deps.logger.info('recovery:reset-to-pending', { meetingId: m.id, from: rolled });
  }
}
