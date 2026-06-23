import fs from 'node:fs';
import path from 'node:path';
import type { ExportInput, Exporter } from './interface.js';

/** Render a meeting as Markdown: title + summary + an action-items checklist.
 *  Shared by the Markdown file exporter and the Google Doc exporter (which
 *  uploads this content to Drive for conversion to a Doc). */
export function buildMeetingMarkdown(input: ExportInput): string {
  const lines: string[] = [`# ${input.meetingTitle}`, ''];
  const summary = input.summaryMd?.trim();
  if (summary) {
    lines.push(summary, '');
  }
  lines.push('## Action Items', '');
  for (const it of input.items) {
    const box = it.status === 'done' ? '[x]' : '[ ]';
    const parts = [it.text];
    if (it.ownerName) parts.push(it.ownerName);
    if (it.dueDate) parts.push(`due ${it.dueDate}`);
    lines.push(`- ${box} ${parts.join(' — ')}`);
  }
  return lines.join('\n');
}

export class MarkdownExporter implements Exporter {
  name = 'markdown';

  async export(input: ExportInput): Promise<string> {
    const out = input.outputPath ?? path.join(input.meetingFolder, 'exports', 'action-items.md');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, buildMeetingMarkdown(input));
    return out;
  }
}
