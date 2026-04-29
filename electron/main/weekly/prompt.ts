// electron/main/weekly/prompt.ts
//
// Prompt + parser for the weekly narrative LLM call. Asks for
// structured JSON ({ narrative, decisions }) so we can render the
// pieces independently and not have to parse markdown headings
// out of free-form prose.
//
// Pure functions (no IO). Used by the aggregator's
// generateNarrative dependency, and tested separately so prompt
// regressions surface fast.

import type { LMStudioClient } from '../lm-studio/client.js';
import type { NarrativeInput, NarrativeOutput } from './aggregator.js';

const SYSTEM_PROMPT = `You synthesize a person's week of meeting notes into a short shareable summary.

Return JSON with exactly two fields:
- narrative: 2-3 short paragraphs (200-350 words total) covering, in order:
  1. What was the focus / theme of the week.
  2. The key follow-ups owed and to whom.
  3. What's heading into next week.
  Plain prose. No bullet points, no markdown headings, no emoji. Use the user's voice ("you" / "your") naturally.
- decisions: array of 3-6 strings, each one explicit decision made during the week. Format each as "<decision> — <source meeting title>". Only include decisions actually stated in the meeting summaries; don't invent.

Output ONLY the JSON object. No prose before or after, no code fences, no comments.`;

export function buildUserPrompt(input: NarrativeInput): string {
  const meetingsBlock = input.meetings.length === 0
    ? '(no meetings this week)'
    : input.meetings.map((m, i) => {
        const summary = (m.summaryMd ?? '(no summary yet)').trim();
        const dur = m.durationS != null ? `${Math.round(m.durationS / 60)}m` : 'unknown duration';
        return `### Meeting ${i + 1}: ${m.title}
Started: ${m.startedAt}
Duration: ${dur}

${summary}`;
      }).join('\n\n---\n\n');

  const actionsBlock = input.openActions.length === 0
    ? '(none)'
    : input.openActions.map((a) => {
        const due = a.due ? ` (due ${a.due})` : '';
        return `- [${a.owner}] ${a.text}${due}`;
      }).join('\n');

  return `Week: ${input.weekLabel}

Meetings (${input.meetings.length}):
${meetingsBlock}

Open action items:
${actionsBlock}

Now produce the JSON object.`;
}

/** Strips common LLM-around-the-JSON noise: code fences, leading
 *  prose like "Here is the JSON:", trailing periods. */
export function extractJsonBlock(raw: string): string {
  let s = raw.trim();
  // Strip ```json ... ``` fences if present.
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1]!.trim();
  // Strip a leading prose intro before the first '{'.
  const firstBrace = s.indexOf('{');
  if (firstBrace > 0) s = s.slice(firstBrace);
  // Strip anything after the matching closing brace. Walk braces to
  // find the end of the top-level object.
  let depth = 0;
  let end = -1;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end >= 0) s = s.slice(0, end + 1);
  return s;
}

/** Robust parse: extracts JSON, validates shape, normalizes. */
export function parseNarrativeResponse(raw: string): NarrativeOutput {
  const block = extractJsonBlock(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(block);
  } catch (e) {
    throw new Error(
      `weekly narrative: model returned invalid JSON.\n` +
      `Snippet: ${block.slice(0, 200)}…`,
    );
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('weekly narrative: response was not an object');
  }
  const obj = parsed as Record<string, unknown>;
  const narrative = typeof obj.narrative === 'string' ? obj.narrative.trim() : '';
  const decisionsRaw = Array.isArray(obj.decisions) ? obj.decisions : [];
  const decisions = decisionsRaw
    .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
    .map((x) => x.trim());
  if (!narrative) {
    throw new Error('weekly narrative: model returned an empty narrative');
  }
  return { narrative, decisions };
}

/** Wires the prompt + parser to an LMStudioClient. Returned function
 *  matches the AggregatorDeps.generateNarrative signature. */
export function createNarrativeGenerator(
  lmStudio: LMStudioClient,
  getModelId: () => string,
): (input: NarrativeInput) => Promise<NarrativeOutput> {
  return async (input) => {
    const raw = await lmStudio.chat({
      model: getModelId(),
      temperature: 0.3,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(input) },
      ],
    });
    return parseNarrativeResponse(raw);
  };
}
