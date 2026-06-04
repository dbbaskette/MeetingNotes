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
import type { NarrativeInput, NarrativeOutput, WeeklyTheme } from './aggregator.js';

const SYSTEM_PROMPT = `You synthesize a person's week of meeting notes into a detailed summary they can use to catch up on and recall what actually happened.

Return JSON with exactly three fields:
- narrative: 2-3 short paragraphs (200-350 words total) giving the high-level shape of the week: the overall focus, the key follow-ups owed and to whom, and what's heading into next week. Plain prose. No bullet points, no markdown headings, no emoji. Use the user's voice ("you" / "your") naturally.
- themes: array of 3-6 topic threads that run through the week — this is the most important field for recall. Each theme is an object:
    - title: a short noun phrase naming the thread (e.g. "Q3 Postgres migration", "Hiring", "Pricing rework").
    - detail: 2-4 sentences on what was actually discussed across the week, where it landed, and what's still open. Be concrete — name the substance, not just that it "was discussed".
    - meetings: array of the source meeting TITLES (verbatim, as given below) this thread draws from.
  Group related discussions even when they span multiple meetings. Only build threads from what's in the summaries; don't invent. Cover the substantive topics — don't collapse the week into one vague theme.
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
  return { narrative, themes: parseThemes(obj.themes), decisions };
}

/** Coerce the model's `themes` field into well-formed WeeklyTheme objects.
 *  Tolerant by design: a model that omits the field, or emits a malformed
 *  entry, degrades to fewer/no themes rather than failing the whole call.
 *  Drops entries missing a title or detail; normalizes `meetings` to a
 *  string array; caps detail length defensively. */
function parseThemes(raw: unknown): WeeklyTheme[] {
  if (!Array.isArray(raw)) return [];
  const themes: WeeklyTheme[] = [];
  for (const t of raw) {
    if (!t || typeof t !== 'object') continue;
    const o = t as Record<string, unknown>;
    const title = typeof o.title === 'string' ? o.title.trim() : '';
    const detail = typeof o.detail === 'string' ? o.detail.trim() : '';
    if (!title || !detail) continue;
    const meetings = Array.isArray(o.meetings)
      ? o.meetings
          .filter((m): m is string => typeof m === 'string' && m.trim().length > 0)
          .map((m) => m.trim())
      : [];
    themes.push({ title, detail: detail.slice(0, 1200), meetings });
  }
  return themes;
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
      // The response now carries narrative + 3-6 themes + decisions as JSON;
      // give the decoder generous headroom so the object isn't truncated
      // mid-array (which would make the JSON unparseable).
      maxTokens: 2000,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(input) },
      ],
    });
    return parseNarrativeResponse(raw);
  };
}
