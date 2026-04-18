import type { MeetingsRepo } from '../storage/meetings-repo.js';
import type { Logger } from '../logging/logger.js';
import { previousCompletedOnCrash, type Stage } from '../lib/stage-machine.js';

export interface RecoveryDeps {
  meetings: MeetingsRepo;
  enqueue: (meetingId: string) => void;
  logger: Logger;
}

// Re-enqueue meetings that were processing when the app died. Skip 'failed' —
// those need an explicit user rerun.
export function recoverPendingMeetings(deps: RecoveryDeps): void {
  for (const m of deps.meetings.findResumable()) {
    const rolled = previousCompletedOnCrash(m.pipelineStage as Stage);
    if (rolled !== m.pipelineStage) deps.meetings.updateStage(m.id, rolled);
    deps.logger.info('recovery:resume', { meetingId: m.id, from: rolled });
    deps.enqueue(m.id);
  }
}
