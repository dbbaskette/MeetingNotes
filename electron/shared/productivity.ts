import { z } from 'zod';
export const ActionFilterSchema = z.object({
  owner: z.string().max(200).default('mine'),
  groupId: z.string().max(200).optional(),
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
  meetings: { id: string; title: string; startedAt: string; decisions: string[]; questions: string[]; overview: string; missingNotes: boolean }[];
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
