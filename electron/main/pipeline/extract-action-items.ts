// electron/main/pipeline/extract-action-items.ts
//
// The ONE place the "extract action items from summary.md" behavior lives.
// Two callers share it: the pipeline's extract stage (stages/extracting.ts)
// and the state-neutral `action-items:reextract` IPC handler — previously
// copy-pasted twins with a "keep them in lockstep" comment doing the
// lockstep-keeping by hand.
//
// Why the summary and not the transcript: summary.md is 10–30x smaller, which
// keeps 12B-class reasoning models (Gemma 4, Qwen3) from burning their whole
// token budget "thinking" about a transcript-sized input. The summary prompt's
// Action Items rule is recall-oriented specifically so this step has
// everything it needs; deliberately NO transcript fallback — that would
// silently reintroduce the failing path.
import fs from 'node:fs';
import path from 'node:path';
import { ACTION_ITEM_SYSTEM_PROMPT } from './prompts.js';
import { parseActionItemsLoose } from '../lib/action-item-schema.js';
import { matchSourceQuotes } from '../lib/action-item-source.js';
import type { LMStudioClient } from '../lm-studio/client.js';
import type { SettingsRepo } from '../storage/settings-repo.js';
import type { ActionItemsRepo } from '../storage/action-items-repo.js';

/** Output cap for the extraction call. The summary input is 1–3k tokens and
 *  the JSON answer is short, so this is generous for a well-behaved model
 *  while bounding a still-looping reasoning model to tens of seconds instead
 *  of minutes. The client rejects budget-burned/looping output. */
export const EXTRACT_MAX_TOKENS = 2000;

export interface ExtractActionItemsDeps {
  lmStudio: Pick<LMStudioClient, 'chat'>;
  /** Wakes a managed LLM provider on demand; no-op for user-managed ones. */
  llmSupervisor: { ensureReady(): Promise<void> };
  settings: Pick<SettingsRepo, 'get'>;
  actionItems: Pick<ActionItemsRepo, 'replaceForMeeting'>;
}

/** Run the extraction against the meeting folder's saved summary.md, persist
 *  the result (action-items.json + repo), and return the items. Attaches
 *  source-quote provenance by matching each item back to the verbatim summary
 *  bullet it was reworded from (pure/LLM-free; unmatched items get null and
 *  simply show no "show source" affordance).
 *
 *  `missingSummaryHint` finishes the error when summary.md is absent/empty —
 *  the right next step differs by caller (pipeline: re-run processing;
 *  re-extract button: save a summary first). */
export async function extractActionItemsFromSummary(
  deps: ExtractActionItemsDeps,
  meetingId: string,
  folder: string,
  missingSummaryHint: string,
): Promise<{ count: number }> {
  const summaryPath = path.join(folder, 'summary.md');
  const summary = fs.existsSync(summaryPath) ? fs.readFileSync(summaryPath, 'utf8').trim() : '';
  if (!summary) {
    throw new Error(`summary.md is missing or empty — ${missingSummaryHint}`);
  }
  await deps.llmSupervisor.ensureReady();
  const raw = await deps.lmStudio.chat({
    model: deps.settings.get('llmModel'),
    temperature: 0,
    disableThinking: deps.settings.get('disableThinking'),
    maxTokens: EXTRACT_MAX_TOKENS,
    messages: [
      { role: 'system', content: ACTION_ITEM_SYSTEM_PROMPT },
      { role: 'user', content: summary },
    ],
  });
  const items = matchSourceQuotes(parseActionItemsLoose(raw), summary);
  fs.writeFileSync(path.join(folder, 'action-items.json'), JSON.stringify(items, null, 2));
  deps.actionItems.replaceForMeeting(meetingId, items);
  return { count: items.length };
}
