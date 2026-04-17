import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Exporter, ExportInput } from './interface';

const pExecFile = promisify(execFile);
type Runner = (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
const defaultRunner: Runner = (c, a) => pExecFile(c, a, { timeout: 10000 });

export class AppleRemindersExporter implements Exporter {
  name = 'reminders';
  private readonly runner: Runner;
  private readonly listName: string;

  constructor(deps: { runner?: Runner; listName?: string } = {}) {
    this.runner = deps.runner ?? defaultRunner;
    this.listName = deps.listName ?? 'MeetingNotes';
  }

  async export(input: ExportInput): Promise<string> {
    const list = this.listName.replace(/"/g, '\\"');
    const open = input.items.filter((i) => i.status !== 'done');
    for (const it of open) {
      const body = it.text.replace(/"/g, '\\"');
      const nameParts = [body];
      if (it.ownerName) nameParts.push(`(${it.ownerName})`);
      const name = nameParts.join(' ');
      const due = it.dueDate ? `, remind me date: date "${it.dueDate}"` : '';
      const script = `tell application "Reminders" to make new reminder at list "${list}" with properties {name:"${name}"${due}}`;
      const { stderr } = await this.runner('osascript', ['-e', script]);
      if (stderr.trim()) throw new Error(`Reminders export failed: ${stderr.trim()}`);
    }
    return `${open.length} reminders added to "${this.listName}"`;
  }
}
