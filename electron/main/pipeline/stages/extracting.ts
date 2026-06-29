// electron/main/pipeline/stages/extracting.ts
import fs from 'node:fs';
import path from 'node:path';
import type { StageHandler } from '../context.js';
import { meetingFolderPath } from '../../storage/meeting-folder.js';
import { ACTION_ITEM_SYSTEM_PROMPT } from '../prompts.js';
import { parseActionItemsLoose } from '../../lib/action-item-schema.js';

export const runExtracting: StageHandler = async ({ meetingId }, ctx) => {
  const meeting = ctx.meetings.findById(meetingId);
  if (!meeting) throw new Error(`meeting not found: ${meetingId}`);
  const folder = meetingFolderPath(ctx.libraryRoot, meeting.slug);
  const transcript = fs.readFileSync(path.join(folder, 'transcript.md'), 'utf8');
  // Wake the LLM provider on demand. No-op when summaryProvider='external'
  // (user-managed LM Studio / Ollama). For managed providers, spawns the
  // server if needed and resets the idle timer.
  await ctx.llmSupervisor.ensureReady();
  const raw = await ctx.lmStudio.chat({
    model: ctx.settings.get('llmModel'),
    temperature: 0,
    disableThinking: ctx.settings.get('disableThinking'),
    // Bound a runaway/looping generation. The JSON action-item list is short,
    // but a reasoning model spends most of its budget thinking first, so keep
    // generous headroom; the client also rejects degenerate looping output.
    maxTokens: 6000,
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
