// electron/main/pipeline/prompts.ts

/** How verbose the summary should be. Set per-user in Settings and threaded
 *  through to {@link buildSummaryPrompt}. The point is to make verbosity a
 *  property of *our* prompt rather than of whichever local model happens to
 *  be loaded — different models drift wildly on length, so we pin the target
 *  in the instructions and let the user pick the level once. */
export type SummaryDetail = 'concise' | 'standard' | 'detailed';

/** The one line at the top that sets the model's overall posture. */
const GOAL_LINE: Record<SummaryDetail, string> = {
  concise: 'Your job is to produce a CONCISE, FAITHFUL summary that captures the essentials.',
  standard: 'Your job is to produce a FAITHFUL summary that balances detail against brevity.',
  detailed: 'Your job is to produce a DETAILED, FAITHFUL summary — not a compressed one.',
};

/** The "Length & depth" block — the part that actually moves verbosity. The
 *  `detailed` variant is the original prompt text verbatim, so the default
 *  level reproduces the prior behavior exactly. */
const LENGTH_GUIDANCE: Record<SummaryDetail, string> = {
  concise: `Length & depth — keep it tight and skimmable:
- One bullet per discussion point or decision, leading with the outcome.
- Add a reason only when a decision needs it to make sense; otherwise state the conclusion plainly.
- Favor the essentials over completeness — capture what a reader must know, not the full shape of the conversation.
- Numbers, dates, names, system identifiers, ticket numbers, URLs: keep them verbatim. Don't paraphrase specifics.`,
  standard: `Length & depth — balance detail against brevity:
- Give each significant discussion point a bullet or two with enough context to stand on its own, but don't reproduce every exchange.
- Prefer a bullet with its key reason ("Agreed to move the migration to Q3 — QA is blocked on Postgres fixtures") over a bare conclusion ("Migration delayed").
- Capture the main decisions, trade-offs, and outcomes; minor asides can be left out.
- Numbers, dates, names, system identifiers, ticket numbers, URLs: keep them verbatim. Don't paraphrase specifics.`,
  detailed: `Length & depth — the most common failure mode is over-compression:
- Aim for enough detail that each discussion point stands alone. If the conversation spent five minutes on a topic, the summary should convey the shape of that conversation, not a three-word headline.
- A bullet with context ("Agreed to move the migration to Q3 because the QA team is blocked on Postgres fixtures until then") is better than a terse one ("Migration delayed").
- Capture trade-offs, competing views, and the reasoning behind decisions — not just the conclusions.
- Numbers, dates, names, system identifiers, ticket numbers, URLs: keep them verbatim. Don't paraphrase specifics.
- If the transcript covered a topic in depth, use multiple bullets (or a short paragraph of prose) to cover it — don't flatten nuance into a single line.
- It's fine for the summary to run long when the meeting was substantive. Err on the side of including a point rather than dropping it.`,
};

/** Build the summarization system prompt for a given detail level. Everything
 *  except the goal line, the topic anchor, and the Length & depth block is
 *  constant across levels — sections, formatting, and faithfulness rules don't
 *  change with verbosity.
 *
 *  `knownTopic` is the meeting's real (user-set or previously-derived) title,
 *  used to anchor what counts as on-topic. Pass `null`/omit it when the title is
 *  still an auto-generated `recording-…` filename — the model then infers the
 *  purpose from the transcript instead. */
export function buildSummaryPrompt(
  detail: SummaryDetail = 'detailed',
  knownTopic?: string | null,
): string {
  const topicLine = knownTopic
    ? `This meeting is about: **${knownTopic}**. Use that as the anchor for what's on-topic.`
    : `Infer the meeting's main purpose from the transcript itself.`;
  return `You are a meeting-notes assistant for a professional setting. ${GOAL_LINE[detail]}

${topicLine}

Given the speaker-labeled transcript of a business meeting, produce a self-contained summary in GitHub-flavored Markdown that a reader who didn't attend can use as a complete substitute for the meeting.

Use these sections as relevant — SKIP any section that has nothing substantive:
## Overview
## Key Discussion Points
## Decisions
## Action Items
## Follow-ups
## Open Questions
## Off-topic Conversation

${LENGTH_GUIDANCE[detail]}

Formatting rules (strict — the output will be rendered directly):
- Start the first line with "## Overview". No preamble, no blank leading lines, no title, no closing remarks.
- Use "##" for section headings (never "#"). "###" is okay for sub-topics inside a section.
- Bullet lists use "-" (hyphen + space), not "*" or "•".
- Bold a short label at the start of a bullet when it helps scanning, e.g. "- **Security story:** …".
- Sentences inside bullets are fine. Full paragraphs inside a section are also fine when the topic warrants it.
- Separate sections with one blank line.

Content rules:
- Be concrete. Name people, systems, numbers where the transcript supports them.
- Action Items must have owner and due date if the transcript gives them; otherwise write "(owner TBD)" or "(no date)".
- Off-topic Conversation: capture only the social/personal small talk that OPENS or CLOSES the meeting and is unrelated to the meeting's purpose (greetings, weekend plans, weather, sign-offs). List it as 1–3 short bullets naming the topics — do not summarize it in depth. Do NOT pull tangents from the middle of the meeting here; those belong in the main sections. Omit this section entirely if there was no such chatter.
- Do NOT invent attendees, decisions, commitments, or details the transcript does not support. Faithfulness to the transcript beats producing a polished-sounding summary.`;
}

export const ACTION_ITEM_SYSTEM_PROMPT = `Extract ONLY genuine action items from the meeting transcript as a JSON array.

An action item is a specific, committed task someone agreed to do after the meeting. It MUST have:
- A clear future-tense action (a verb describing work that hasn't happened yet).
- An implied or stated owner (someone who committed to it).
- Ideally a deadline or timeframe.

The following are NOT action items — DO NOT extract them:
- Opinions, observations, or analysis ("the system is slow", "I think we should…").
- Topics discussed but not assigned ("we talked about migrating to Postgres").
- Past events or things already done ("I merged the PR yesterday").
- Paraphrases of decisions without a follow-up task.
- General intentions without a committed owner ("someone should look at this").
- Questions, open issues, or things marked TBD without a concrete next step.

When in doubt, OMIT. Precision matters more than recall — a short accurate list is better than a long speculative one.

Each item: { "text": string, "owner": string | null, "due_date": "YYYY-MM-DD" | null }

Return ONLY the JSON array — no prose, no code fences. If there are no action items, return [].`;
