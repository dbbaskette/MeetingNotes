// electron/main/pipeline/stages/summarizing.ts
import fs from 'node:fs';
import path from 'node:path';
import type { StageHandler } from '../context.js';
import { meetingFolderPath } from '../../storage/meeting-folder.js';
import { buildSummaryPrompt } from '../prompts.js';

/** Filename-derived default title like `recording-20260421-163203-47c0c0f5`.
 *  Used to detect whether the meeting's title is still auto-generated (and
 *  therefore safe to overwrite with something derived from the summary)
 *  vs. something the user chose by hand. */
const DEFAULT_TITLE_PATTERN = /^recording-\d{8}-\d{6}-[a-z0-9]+$/i;

/** Pull a short, human-readable title from the LLM's Overview. Rule-based
 *  because we don't want another LLM round-trip for a title we're only
 *  going to use as a default. Returns null if the extraction is too short
 *  or doesn't look prose-like. */
export function extractTitleFromSummary(summary: string): string | null {
  // Find the Overview section — bounded by the next "##" heading or EOF.
  // Use [ \t]* instead of \s* for the trailing heading whitespace so we
  // don't accidentally consume blank lines after the heading (which would
  // pull the next section's body in as "Overview").
  const match = summary.match(/^##\s+Overview[ \t]*\n([\s\S]*?)(?=\n##\s|\s*$)/im);
  if (!match) return null;
  const body = (match[1] ?? '').trim();
  if (!body) return null;
  // First non-empty line, stripped of leading bullet/dash/quote syntax.
  const firstLine = body.split('\n').map((l) => l.trim()).find(Boolean);
  if (!firstLine) return null;
  // Strip leading bullet markers, then if the line leads with a bold label
  // like "**Security review:**" (colon inside or outside the asterisks)
  // collapse it to "Label — ..." so the title reads as prose.
  const prose = firstLine
    .replace(/^[-*>]\s+/, '')
    .replace(/^\*\*([^*]+?)\*\*:?\s*/, (_, label: string) => `${label.replace(/:$/, '').trim()} — `);
  // First sentence if one fits in 70 chars, otherwise truncate.
  const sentenceEnd = prose.search(/[.!?](\s|$)/);
  let title = sentenceEnd > 0 ? prose.slice(0, sentenceEnd) : prose;
  title = title.trim();
  if (title.length > 70) title = title.slice(0, 67).trimEnd() + '…';
  if (title.length < 8) return null;
  return title;
}

/** Strip a leading reasoning/preamble leak before the real summary.
 *
 *  The prompt requires the output to begin with "## Overview". Reasoning
 *  models that emit chain-of-thought WITHOUT <think> tags (e.g. gemma-*-a4b)
 *  slip past {@link stripThinking} and prepend their planning — which also
 *  *mentions* the section names — before the actual summary. Since reasoning
 *  always precedes the answer, the genuine summary is the LAST "## Overview"
 *  heading; when the output doesn't already start cleanly with an Overview
 *  heading, slice from there (which also drops any prefix glued onto that
 *  line, like "*(Proceed to generate output)*"). Clean output is returned
 *  untouched, so a well-behaved model is never over-trimmed. */
export function stripSummaryPreamble(md: string): string {
  const text = md.trimStart();
  // Already clean — starts with an Overview heading (any heading level; the
  // H1→H2 demotion runs afterwards).
  if (/^#{1,6}\s+Overview\b/i.test(text)) return text;
  const matches = [...md.matchAll(/#{1,6}\s+Overview\b/gi)];
  if (matches.length === 0) return md; // no heading to anchor on — leave as-is
  const lastIdx = matches[matches.length - 1]!.index ?? -1;
  return lastIdx > 0 ? md.slice(lastIdx) : md;
}

export const runSummarizing: StageHandler = async ({ meetingId }, ctx) => {
  const meeting = ctx.meetings.findById(meetingId);
  if (!meeting) throw new Error(`meeting not found: ${meetingId}`);
  const folder = meetingFolderPath(ctx.libraryRoot, meeting.slug);
  const transcript = fs.readFileSync(path.join(folder, 'transcript.md'), 'utf8');
  // Wake the LLM provider on demand (managed mode) or no-op
  // (external mode). See ctx.llmSupervisor docs.
  await ctx.llmSupervisor.ensureReady();
  // Anchor off-topic detection on the meeting's real title. A still-default
  // `recording-…` filename tells us nothing, so fall back to letting the model
  // infer the purpose from the transcript.
  const knownTopic = DEFAULT_TITLE_PATTERN.test(meeting.title) ? null : meeting.title;
  const content = await ctx.lmStudio.chat({
    model: ctx.settings.get('llmModel'),
    temperature: 0.2,
    messages: [
      { role: 'system', content: buildSummaryPrompt(ctx.settings.get('summaryDetail'), knownTopic) },
      { role: 'user', content: transcript },
    ],
  });
  // Post-process LLM output to survive formatting drift:
  //  - drop a leading reasoning/preamble leak (reasoning models that don't
  //    use <think> tags prepend their chain-of-thought before "## Overview")
  //  - strip leading / trailing whitespace (models love to open with a
  //    couple of blank lines)
  //  - demote accidental "# Overview" H1s to "## Overview" — the prompt
  //    asks for H2 but smaller models occasionally ignore that, and H1
  //    inside the app looks like a page title
  //  - collapse "*" bullets to "-" so the preview renders consistently
  const cleaned = stripSummaryPreamble(content)
    .trim()
    .replace(/^# (Overview|Key Discussion Points|Decisions|Action Items|Follow-ups|Open Questions|Off-topic Conversation)\b/gm, '## $1')
    .replace(/^(\s*)\* /gm, '$1- ');
  fs.writeFileSync(path.join(folder, 'summary.md'), cleaned);
  ctx.logger.info('summarize:done', { meetingId, chars: cleaned.length });

  // Auto-suggest a title from the Overview only if the current title is
  // still the auto-generated filename. This is the common case for built-in
  // recordings ("recording-20260421-163203-47c0c0f5"); user-renamed meetings
  // and Audio Hijack imports with a configured name are left untouched.
  if (DEFAULT_TITLE_PATTERN.test(meeting.title)) {
    const derived = extractTitleFromSummary(cleaned);
    if (derived) {
      ctx.meetings.updateTitle(meetingId, derived);
      ctx.logger.info('summarize:auto-title', { meetingId, title: derived });
    }
  }
};
