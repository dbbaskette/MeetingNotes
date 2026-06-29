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

/** Actionable message for the case where the model's JSON was cut off. The
 *  usual cause is a reasoning model spending most of its token budget
 *  "thinking" before it writes the answer, so the JSON never finishes. */
const TRUNCATED_MSG =
  `weekly narrative: the model's output was cut off before it finished — it hit ` +
  `the token limit. A reasoning model often spends most of its budget "thinking" ` +
  `before it writes the answer. In LM Studio, switch to a non-reasoning model (or ` +
  `turn off the model's thinking), then regenerate.`;

/** Recover the largest valid JSON prefix from a string that was cut off
 *  mid-generation. Walks the JSON grammar tracking complete values; on a cut,
 *  returns the substring up to the last fully-emitted value with the still-open
 *  containers closed. Returns `{ json: null }` when nothing completed (e.g. the
 *  cut landed inside the very first value). `truncated` reports whether the
 *  input was structurally incomplete at all — so the caller can tell a genuine
 *  cut-off apart from balanced-but-malformed garbage. */
export function recoverTruncatedJson(s: string): { json: string | null; truncated: boolean } {
  type Frame = { type: 'obj' | 'arr'; expect: 'key' | 'colon' | 'value' | 'comma' };
  const stack: Frame[] = [];
  // The best (latest) point we can safely cut at: the byte length to keep, plus
  // the closing brackets that re-balance the containers open at that point.
  let best: { len: number; closers: string } | null = null;

  const checkpoint = (offset: number) => {
    let closers = '';
    for (let k = stack.length - 1; k >= 0; k--) closers += stack[k]!.type === 'obj' ? '}' : ']';
    best = { len: offset, closers };
  };
  // A value finished at `offset`. Advance the enclosing container and record a
  // cut point. A root-level primitive has no enclosing container — ignore it
  // (our schema is always a root object, so this never feeds a real salvage).
  const onValueComplete = (offset: number) => {
    const top = stack[stack.length - 1];
    if (!top) return;
    top.expect = 'comma';
    checkpoint(offset);
  };
  const bail = (truncated: boolean) =>
    ({ json: best ? s.slice(0, best.len) + best.closers : null, truncated });

  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i]!;
    if (c === ' ' || c === '\n' || c === '\r' || c === '\t') { i++; continue; }
    const top = stack[stack.length - 1];

    if (c === '{' || c === '[') {
      const type = c === '{' ? 'obj' : 'arr';
      stack.push({ type, expect: type === 'obj' ? 'key' : 'value' });
      i++;
      continue;
    }
    if (c === '}' || c === ']') {
      if (!top) break;
      stack.pop();
      i++;
      onValueComplete(i); // the closed container is a completed value for its parent
      continue;
    }
    if (c === ':') {
      if (top && top.type === 'obj' && top.expect === 'colon') top.expect = 'value';
      i++;
      continue;
    }
    if (c === ',') {
      if (top) top.expect = top.type === 'obj' ? 'key' : 'value';
      i++;
      continue;
    }
    if (c === '"') {
      i++;
      let closed = false;
      while (i < n) {
        const ch = s[i]!;
        if (ch === '\\') { i += 2; continue; }
        if (ch === '"') { closed = true; i++; break; }
        i++;
      }
      if (!closed) return bail(true); // cut off inside a string
      // An object key (expecting 'key') just names the next field; only a value
      // string advances the container and counts as a cut point.
      if (top && top.type === 'obj' && top.expect === 'key') top.expect = 'colon';
      else onValueComplete(i);
      continue;
    }
    // number / true / false / null
    if (c === '-' || (c >= '0' && c <= '9') || c === 't' || c === 'f' || c === 'n') {
      const start = i;
      while (i < n && /[A-Za-z0-9.+-]/.test(s[i]!)) i++;
      if (i >= n) return bail(true); // possibly-truncated literal at EOF — drop it
      void start;
      onValueComplete(i);
      continue;
    }
    break; // unrecognized char
  }
  return bail(stack.length > 0);
}

/** Robust parse: extracts JSON, validates shape, normalizes. Tolerates a
 *  response cut off mid-generation by salvaging the fields that fully emitted
 *  before the cut (the narrative is first, so it usually survives); if not even
 *  the narrative made it, surfaces an actionable "output was cut off" error
 *  rather than a confusing "invalid JSON". */
export function parseNarrativeResponse(raw: string): NarrativeOutput {
  const block = extractJsonBlock(raw);
  let parsed: unknown;
  let salvaged = false;
  try {
    parsed = JSON.parse(block);
  } catch {
    const rec = recoverTruncatedJson(block);
    if (rec.json !== null) {
      try { parsed = JSON.parse(rec.json); salvaged = true; } catch { /* fall through */ }
    }
    if (!salvaged) {
      if (rec.truncated) throw new Error(TRUNCATED_MSG);
      throw new Error(
        `weekly narrative: model returned invalid JSON.\n` +
        `Snippet: ${block.slice(0, 200)}…`,
      );
    }
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
    // A salvage that didn't even recover the narrative is a cut-off, not an
    // intentionally-empty answer — point the user at the real cause.
    if (salvaged) throw new Error(TRUNCATED_MSG);
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
      // Generous cap (NOT the 2000 we shipped in 1.5.0). A reasoning model
      // (Qwen3, gemma-*-a4b, etc.) spends its budget in reasoning_content FIRST
      // and only then emits the answer — a small cap got fully consumed by
      // thinking (finish_reason="length", content="") and surfaced as an empty-
      // content error. The weekly narrative is the largest legitimate output in
      // the app (a whole week + 3-6 detailed themes), so 8000 still left the
      // JSON truncated mid-stream on busy weeks → "invalid JSON". 16000 leaves
      // room for heavy reasoning + the full narrative; parseNarrativeResponse
      // salvages anyway if even this is exceeded. Runaway loops stay bounded by
      // looksDegenerate() and the 10-minute request timeout, not this cap.
      maxTokens: 16000,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(input) },
      ],
    });
    return parseNarrativeResponse(raw);
  };
}
