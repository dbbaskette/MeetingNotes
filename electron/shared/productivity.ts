import { z } from 'zod';
export const ActionFilterSchema = z.object({
  owner: z.string().max(200).default('mine'),
  groupId: z.string().max(200).optional(),
  /** Only meetings in no group. Takes precedence over `groupId`. */
  ungrouped: z.boolean().optional(),
  due: z.enum(['all', 'overdue', 'soon', 'undated']).default('all'),
  offset: z.number().int().min(0).max(1_000_000).default(0),
});
export type ActionFilter = z.input<typeof ActionFilterSchema>;
export interface LiveAction {
  id: string; meetingId: string; meetingTitle: string; text: string;
  ownerName: string | null; dueDate: string | null; groupName: string | null;
  processing: boolean;
}
export interface ActionPage { items: LiveAction[]; total: number; owners: string[]; identified: boolean }
export interface GroupBrief {
  meetings: { id: string; title: string; startedAt: string; decisions: string[]; questions: string[]; overview: string; missingNotes: boolean;
    /** Forward-looking sections other templates write (1:1 "Topics for Next
     *  Time", standup "Blockers" / "Planned Next", decision "Next Steps").
     *  Only sections that exist in the notes and have content. */
    prep: { heading: string; items: string[] }[] }[];
  actions: LiveAction[]; openActionCount: number;
}
/** Exact diarizer tokens only: never guess replacements for human names. */
export function resolveSpeakerLabels(text: string, names: Record<string, string>): string {
  return text.replace(/\bSPEAKER_\d+\b/g, label => names[label] ?? label);
}
export function briefSection(markdown: string, heading: string): string[] {
  const lines = markdown.split(/\r?\n/), result: string[] = [];
  let inside = false;
  for (const line of lines) {
    if (/^#{1,3}\s/.test(line)) { inside = line.replace(/^#+\s*/, '').trim().toLocaleLowerCase() === heading.toLocaleLowerCase(); continue; }
    if (inside && line.trim()) result.push(line.replace(/^\s*[-*]\s*/, '').trim());
    if (result.length >= 20) break;
  }
  return result;
}

/** Headings worth carrying into "Prepare next meeting", beyond Decisions and
 *  Open Questions: what each notes template writes for the next conversation. */
export const BRIEF_PREP_HEADINGS = ['Topics for Next Time', 'Blockers and Support Needed', 'Blockers', 'Planned Next', 'Next Steps'] as const;

export function briefPrepSections(markdown: string): { heading: string; items: string[] }[] {
  return BRIEF_PREP_HEADINGS.map(heading => ({ heading, items: briefSection(markdown, heading) })).filter(section => section.items.length > 0);
}

/** A group brief as Markdown, for pasting into an agenda or a chat. */
export function groupBriefMarkdown(groupName: string, brief: GroupBrief): string {
  const out: string[] = [`# Prepare: ${groupName}`, ''];
  out.push(`## Open actions (${brief.openActionCount})`);
  if (brief.actions.length === 0) out.push('- None');
  for (const action of brief.actions) {
    const detail = [action.ownerName ?? 'Unassigned', action.dueDate ? `due ${action.dueDate}` : null].filter(Boolean).join(', ');
    out.push(`- [ ] ${action.text} (${detail})`);
  }
  for (const meeting of brief.meetings) {
    out.push('', `## ${meeting.title} — ${meeting.startedAt.slice(0, 10)}`);
    if (meeting.missingNotes) { out.push('_No notes yet._'); continue; }
    if (meeting.overview) out.push(meeting.overview);
    const sections: [string, string[]][] = [['Decisions', meeting.decisions], ['Open questions', meeting.questions], ...meeting.prep.map(section => [section.heading, section.items] as [string, string[]])];
    for (const [heading, items] of sections) {
      if (items.length === 0) continue;
      out.push('', `### ${heading}`, ...items.map(item => `- ${item}`));
    }
  }
  return out.join('\n') + '\n';
}
