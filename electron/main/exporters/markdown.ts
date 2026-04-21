import fs from 'node:fs';
import path from 'node:path';
import type { ExportInput, Exporter } from './interface.js';

export class MarkdownExporter implements Exporter {
  name = 'markdown';

  async export(input: ExportInput): Promise<string> {
    const lines: string[] = [`# ${input.meetingTitle} — Action Items`, ''];
    for (const it of input.items) {
      const box = it.status === 'done' ? '[x]' : '[ ]';
      const parts = [it.text];
      if (it.ownerName) parts.push(it.ownerName);
      if (it.dueDate) parts.push(`due ${it.dueDate}`);
      lines.push(`- ${box} ${parts.join(' — ')}`);
    }
    const out = input.outputPath ?? path.join(input.meetingFolder, 'exports', 'action-items.md');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, lines.join('\n'));
    return out;
  }
}
