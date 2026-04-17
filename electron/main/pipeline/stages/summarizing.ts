// electron/main/pipeline/stages/summarizing.ts
import fs from 'node:fs';
import path from 'node:path';
import type { StageHandler } from '../context';
import { meetingFolderPath } from '../../storage/meeting-folder';
import { SUMMARY_SYSTEM_PROMPT } from '../prompts';

export const runSummarizing: StageHandler = async ({ meetingId }, ctx) => {
  const meeting = ctx.meetings.findById(meetingId);
  if (!meeting) throw new Error(`meeting not found: ${meetingId}`);
  const folder = meetingFolderPath(ctx.libraryRoot, meeting.slug);
  const transcript = fs.readFileSync(path.join(folder, 'transcript.md'), 'utf8');
  const content = await ctx.lmStudio.chat({
    model: ctx.settings.get('llmModel'),
    temperature: 0.2,
    messages: [
      { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
      { role: 'user', content: transcript },
    ],
  });
  fs.writeFileSync(path.join(folder, 'summary.md'), content);
  ctx.logger.info('summarize:done', { meetingId, chars: content.length });
};
