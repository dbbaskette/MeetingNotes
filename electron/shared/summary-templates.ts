// Summary templates (#254): the shape of the notes for a kind of meeting.
//
// A template changes which optional sections the model is asked for and adds
// a short brief about the meeting type. Four sections are fixed in every
// template because other code depends on them:
//   Overview              -> the Weekly view's recap (weekly/recap.ts)
//   Decisions             -> the Weekly view's decisions
//   Action Items          -> action-item extraction and export clean-up
//   Off-topic Conversation -> small talk is moved here, never duplicated
//
// Templates are built in. They are chosen per group (a default) or per
// meeting (an override); `general` reproduces the original prompt exactly.

export interface SummaryTemplate {
  id: string;
  name: string;
  /** One line shown beside the name in pickers. */
  description: string;
  /** Sections between Overview and Decisions, in order. */
  before: readonly string[];
  /** Sections between Action Items and Off-topic Conversation, in order. */
  after: readonly string[];
  /** Brief for the model about this kind of meeting; empty for `general`. */
  brief: string;
}

export const GENERAL_TEMPLATE_ID = 'general';

export const SUMMARY_TEMPLATES: readonly SummaryTemplate[] = [
  {
    id: GENERAL_TEMPLATE_ID,
    name: 'General',
    description: 'Discussion points, decisions, follow-ups and open questions.',
    before: ['Key Discussion Points'],
    after: ['Follow-ups', 'Open Questions'],
    brief: '',
  },
  {
    id: 'one-on-one',
    name: '1:1',
    description: 'Updates, feedback, blockers and topics for next time.',
    before: ['Updates', 'Feedback and Growth', 'Blockers and Support Needed'],
    after: ['Topics for Next Time'],
    brief: 'This is a one-on-one between two people. Attribute each update, concern and commitment to the person who raised it. Report feedback as it was said, without softening or strengthening it, and keep personal remarks brief and factual.',
  },
  {
    id: 'standup',
    name: 'Standup',
    description: 'Progress, plans and blockers, per person.',
    before: ['Progress', 'Planned Next', 'Blockers'],
    after: [],
    brief: 'This is a short status meeting. Under Progress, Planned Next and Blockers, give each person their own bullet starting with their name in bold. Keep each bullet to what that person actually reported; do not merge people together.',
  },
  {
    id: 'customer-call',
    name: 'Customer call',
    description: 'Customer context, needs, objections and next steps.',
    before: ['Customer Context', 'Needs and Pain Points', 'Objections and Risks'],
    after: ['Next Steps', 'Open Questions'],
    brief: 'This is a conversation with a customer or prospect. Keep what the customer said separate from what our side said. State requirements, numbers, dates and product names exactly as the customer gave them, and record objections even when they were answered.',
  },
  {
    id: 'interview',
    name: 'Interview',
    description: 'Background, strengths, concerns and notable answers.',
    before: ['Candidate Background', 'Strengths', 'Concerns', 'Notable Answers'],
    after: ['Open Questions'],
    brief: 'This is a job interview. Report evidence from the conversation: what was asked and how the candidate answered. Do not give a hire or no-hire recommendation unless an interviewer stated one, and do not infer personal characteristics the candidate did not mention.',
  },
  {
    id: 'decision-review',
    name: 'Decision review',
    description: 'Options, trade-offs, the decision, and its risks.',
    before: ['Options Considered', 'Trade-offs'],
    after: ['Risks and Mitigations', 'Open Questions'],
    brief: 'This meeting exists to make or review a decision. Lay out each option that was considered with the arguments made for and against it, then state what was decided, by whom, and what would cause it to be revisited.',
  },
];

export const REQUIRED_SUMMARY_SECTIONS = ['Overview', 'Decisions', 'Action Items', 'Off-topic Conversation'] as const;

export function isSummaryTemplateId(id: unknown): id is string {
  return typeof id === 'string' && SUMMARY_TEMPLATES.some((template) => template.id === id);
}

/** Unknown or missing ids fall back to General, so a template removed in a
 *  later version never blocks a meeting from being summarized. */
export function summaryTemplate(id: string | null | undefined): SummaryTemplate {
  return SUMMARY_TEMPLATES.find((template) => template.id === id) ?? SUMMARY_TEMPLATES[0]!;
}

/** Every section a template asks for, in output order. */
export function templateSections(template: SummaryTemplate): string[] {
  return ['Overview', ...template.before, 'Decisions', 'Action Items', ...template.after, 'Off-topic Conversation'];
}
