// electron/main/pipeline/stages/extracting.ts
import fs from 'node:fs';
import path from 'node:path';
import type { StageHandler } from '../context';
import { meetingFolderPath } from '../../storage/meeting-folder';
import { ACTION_ITEM_SYSTEM_PROMPT } from '../prompts';
import { parseActionItemsLoose } from '../../lib/action-item-schema';

export const runExtracting: StageHandler = async ({ meetingId }, ctx) => {
  const meeting = ctx.meetings.findById(meetingId);
  if (!meeting) throw new Error(`meeting not found: ${meetingId}`);
  const folder = meetingFolderPath(ctx.libraryRoot, meeting.slug);
  const transcript = fs.readFileSync(path.join(folder, 'transcript.md'), 'utf8');
  const raw = await ctx.lmStudio.chat({
    model: ctx.settings.get('llmModel'),
    temperature: 0,
    messages: [
      { role: 'system', content: ACTION_ITEM_SYSTEM_PROMPT },
      { role: 'user', content: transcript },
    ],
  });
  const items = parseActionItemsLoose(raw);
  fs.writeFileSync(path.join(folder, 'action-items.json'), JSON.stringify(items, null, 2));
  ctx.actionItems.replaceForMeeting(meetingId, items);
  ctx.logger.info('extract:done', { meetingId, items: items.length });
};
