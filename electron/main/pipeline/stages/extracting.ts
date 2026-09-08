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
  const { count, suspectedMiss } = await extractActionItemsFromSummary(
    {
      ...ctx,
      onResample: (retry, words) =>
        ctx.logger.warn('extract:reasoning-retry', { meetingId, retry, reasoningWords: words }),
      onZeroItemsRetry: () =>
        ctx.logger.warn('extract:zero-items-retry', { meetingId }),
    },
    meetingId,
    folder,
    're-run processing so the summarize stage regenerates it before action-item extraction.',
  );
  if (suspectedMiss) {
    ctx.logger.warn('extract:zero-items-suspect', {
      meetingId,
      note: 'summary has Action Items bullets but extraction returned none — try Re-extract or a stronger model',
    });
  }
  ctx.logger.info('extract:done', { meetingId, items: count });
};
