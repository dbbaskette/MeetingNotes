export interface ExportableItem {
  id: string; text: string; ownerName: string | null; dueDate: string | null; status: string;
}
export interface ExportInput {
  items: ExportableItem[];
  meetingTitle: string;
  meetingFolder: string;
  /** Called after each item successfully exports. */
  onItemExported?: (id: string) => void;
  /** Destination path override for file-based exporters. Ignored by exporters
   *  that don't write a single file (Apple Reminders, etc.). When omitted,
   *  the exporter picks its own default location. */
  outputPath?: string;
}
export interface Exporter {
  name: string;
  export(input: ExportInput): Promise<string>;
}

// AppleScript double-quoted string literals only escape `\` and `"`. Backslash
// MUST be escaped first; otherwise a trailing `\` in user input breaks out.
export function escapeAppleScript(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
