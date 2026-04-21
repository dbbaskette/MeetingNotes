// electron/main/pipeline/stages/summarizing.ts
import fs from 'node:fs';
import path from 'node:path';
import type { StageHandler } from '../context.js';
import { meetingFolderPath } from '../../storage/meeting-folder.js';
import { SUMMARY_SYSTEM_PROMPT } from '../prompts.js';

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
  // Post-process LLM output to survive formatting drift:
  //  - strip leading / trailing whitespace (models love to open with a
  //    couple of blank lines)
  //  - demote accidental "# Overview" H1s to "## Overview" — the prompt
  //    asks for H2 but smaller models occasionally ignore that, and H1
  //    inside the app looks like a page title
  //  - collapse "*" bullets to "-" so the preview renders consistently
  const cleaned = content
    .trim()
    .replace(/^# (Overview|Key Discussion Points|Decisions|Action Items|Follow-ups|Open Questions)\b/gm, '## $1')
    .replace(/^(\s*)\* /gm, '$1- ');
  fs.writeFileSync(path.join(folder, 'summary.md'), cleaned);
  ctx.logger.info('summarize:done', { meetingId, chars: cleaned.length });
};
