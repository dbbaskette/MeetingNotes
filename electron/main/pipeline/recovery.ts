import type { MeetingsRepo } from '../storage/meetings-repo';
import type { Logger } from '../logging/logger';
import { previousCompletedOnCrash, type Stage } from '../lib/stage-machine';

export interface RecoveryDeps {
  meetings: MeetingsRepo;
  enqueue: (meetingId: string) => void;
  logger: Logger;
}

export function recoverPendingMeetings(deps: RecoveryDeps): void {
  for (const m of deps.meetings.findNonTerminal()) {
    const rolled = previousCompletedOnCrash(m.pipelineStage as Stage);
    if (rolled !== m.pipelineStage) deps.meetings.updateStage(m.id, rolled);
    deps.logger.info('recovery:resume', { meetingId: m.id, from: rolled });
    deps.enqueue(m.id);
  }
}
