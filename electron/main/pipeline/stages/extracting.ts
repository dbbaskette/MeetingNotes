// electron/main/pipeline/stages/extracting.ts
import type { StageHandler } from '../context.js';
import { meetingFolderPath } from '../../storage/meeting-folder.js';
import { extractActionItemsFromSummary } from '../extract-action-items.js';

/** Extract action items from the summary the summarize stage just wrote.
 *  All the how/why (summary-not-transcript, token cap, provenance matching,
 *  no-fallback rule) lives in extract-action-items.ts, shared with the
 *  `action-items:reextract` IPC handler. */
export const runExtracting: StageHandler = async ({ meetingId }, ctx) => {
  const meeting = ctx.meetings.findById(meetingId);
  if (!meeting) throw new Error(`meeting not found: ${meetingId}`);
  const folder = meetingFolderPath(ctx.libraryRoot, meeting.slug);
  const { count } = await extractActionItemsFromSummary(
    ctx,
    meetingId,
    folder,
    're-run processing so the summarize stage regenerates it before action-item extraction.',
  );
  ctx.logger.info('extract:done', { meetingId, items: count });
};
