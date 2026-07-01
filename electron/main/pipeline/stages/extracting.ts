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
  // Extract from the summary, not the transcript. The stage machine runs
  // summarizing → extracting, so summary.md exists by now, and it is 10–30x
  // smaller than the transcript — small enough that 12B-class reasoning
  // models (Gemma 4, Qwen3) stop burning their whole token budget "thinking"
  // about a transcript-sized input. The summary prompt's Action Items rule is
  // recall-oriented specifically so this stage has everything it needs;
  // deliberately NO transcript fallback — that would silently reintroduce
  // the failing path.
  const summaryPath = path.join(folder, 'summary.md');
  const summary = fs.existsSync(summaryPath) ? fs.readFileSync(summaryPath, 'utf8').trim() : '';
  if (!summary) {
    throw new Error(
      'summary.md is missing or empty — re-run processing so the summarize stage regenerates it before action-item extraction.',
    );
  }
  // Wake the LLM provider on demand. No-op when summaryProvider='external'
  // (user-managed LM Studio / Ollama). For managed providers, spawns the
  // server if needed and resets the idle timer.
  await ctx.llmSupervisor.ensureReady();
  const raw = await ctx.lmStudio.chat({
    model: ctx.settings.get('llmModel'),
    temperature: 0,
    disableThinking: ctx.settings.get('disableThinking'),
    // The summary input is small and the JSON answer is short, so 2000 is
    // generous for a well-behaved model while bounding a still-looping
    // reasoning model to tens of seconds instead of minutes. The client
    // rejects budget-burned/looping output.
    maxTokens: 2000,
    messages: [
      { role: 'system', content: ACTION_ITEM_SYSTEM_PROMPT },
      { role: 'user', content: summary },
    ],
  });
  const items = parseActionItemsLoose(raw);
  fs.writeFileSync(path.join(folder, 'action-items.json'), JSON.stringify(items, null, 2));
  ctx.actionItems.replaceForMeeting(meetingId, items);
  ctx.logger.info('extract:done', { meetingId, items: items.length });
};
