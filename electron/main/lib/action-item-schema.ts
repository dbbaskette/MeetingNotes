import { z } from 'zod';

export const ActionItemSchema = z.object({
  text: z.string().min(1),
  owner: z.string().nullable(),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
});
export type ActionItem = z.infer<typeof ActionItemSchema>;

export const ActionItemsArraySchema = z.array(ActionItemSchema);

// Find the first balanced JSON array in `raw`, scanning past stray brackets in
// any preamble the LLM may have emitted. Returns null if none parses.
function extractFirstJsonArray(raw: string): unknown[] | null {
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== '[') continue;
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let j = i; j < raw.length; j++) {
      const c = raw[j]!;
      if (escape) { escape = false; continue; }
      if (c === '\\' && inString) { escape = true; continue; }
      if (c === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (c === '[') depth += 1;
      else if (c === ']') {
        depth -= 1;
        if (depth === 0) {
          try {
            const parsed = JSON.parse(raw.slice(i, j + 1));
            if (Array.isArray(parsed)) return parsed;
          } catch { /* keep scanning */ }
          break;
        }
      }
    }
  }
  return null;
}

export function parseActionItemsLoose(raw: string): ActionItem[] {
  const arr = extractFirstJsonArray(raw);
  if (!arr) return [];
  const out: ActionItem[] = [];
  for (const item of arr) {
    const r = ActionItemSchema.safeParse(item);
    if (r.success) out.push(r.data);
  }
  return out;
}
