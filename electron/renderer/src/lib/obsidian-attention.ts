// electron/renderer/src/lib/obsidian-attention.ts
//
// Whether Obsidian sync needs the user (#299). A vault that went missing or
// notes paused by an external edit used to be visible only inside
// Settings → Integrations → Obsidian sync; the Library's Needs attention
// inbox now carries one line for it.
export interface ObsidianAttention { message: string; count: number }

export function obsidianAttention(status: {
  config: { enabled: boolean } | null; error: string | null; issues: readonly unknown[];
} | null | undefined): ObsidianAttention | null {
  // Sync that is off, or was never set up, is not a problem to report.
  if (!status?.config?.enabled) return null;
  const notes = status.issues.length;
  if (status.error) {
    return { count: Math.max(1, notes), message: notes > 0
      ? `Obsidian sync is failing (${status.error}) and ${notes} ${notes === 1 ? 'note needs' : 'notes need'} review.`
      : `Obsidian sync is failing: ${status.error}` };
  }
  if (notes === 0) return null;
  return { count: notes, message: `${notes} Obsidian ${notes === 1 ? 'note needs' : 'notes need'} review before ${notes === 1 ? 'it' : 'they'} can sync.` };
}
