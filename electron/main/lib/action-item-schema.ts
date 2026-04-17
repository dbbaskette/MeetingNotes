import { z } from 'zod';

export const ActionItemSchema = z.object({
  text: z.string().min(1),
  owner: z.string().nullable(),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
});
export type ActionItem = z.infer<typeof ActionItemSchema>;

export const ActionItemsArraySchema = z.array(ActionItemSchema);

export function parseActionItemsLoose(raw: string): ActionItem[] {
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw.slice(start, end + 1)); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  const out: ActionItem[] = [];
  for (const item of parsed) {
    const r = ActionItemSchema.safeParse(item);
    if (r.success) out.push(r.data);
  }
  return out;
}
