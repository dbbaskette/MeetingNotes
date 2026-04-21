import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { type Exporter, type ExportInput, escapeAppleScript } from './interface.js';

const pExecFile = promisify(execFile);
type Runner = (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
const defaultRunner: Runner = (c, a) => pExecFile(c, a, { timeout: 10000 });

// AppleScript date literals: tolerate ISO YYYY-MM-DD only.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export class AppleRemindersExporter implements Exporter {
  name = 'reminders';
  private readonly runner: Runner;
  private readonly listName: string;

  constructor(deps: { runner?: Runner; listName?: string } = {}) {
    this.runner = deps.runner ?? defaultRunner;
    this.listName = deps.listName ?? 'MeetingNotes';
  }

  async export(input: ExportInput): Promise<string> {
    const list = escapeAppleScript(this.listName);

    // First run against a clean Reminders DB gave users a cryptic
    // `Can't get list "MeetingNotes". (-1728)` error because the list we're
    // targeting didn't exist yet. Create it idempotently up front. AppleScript
    // doesn't have a CREATE IF NOT EXISTS, so we check with `exists` first.
    const ensureListScript =
      `tell application "Reminders" to if not (exists list "${list}") ` +
      `then make new list with properties {name:"${list}"}`;
    try {
      await this.runner('osascript', ['-e', ensureListScript]);
    } catch (e) {
      throw new Error(
        `Could not create Reminders list "${this.listName}". ` +
        `Open Reminders.app once and grant access, then retry. (${String(e)})`,
      );
    }

    const open = input.items.filter((i) => i.status !== 'done');
    let exported = 0;
    const failures: string[] = [];
    for (const it of open) {
      const body = escapeAppleScript(it.text);
      const owner = it.ownerName ? ` (${escapeAppleScript(it.ownerName)})` : '';
      const name = body + owner;
      const due = it.dueDate && ISO_DATE.test(it.dueDate)
        ? `, remind me date: date "${it.dueDate}"`
        : '';
      const script = `tell application "Reminders" to make new reminder at list "${list}" with properties {name:"${name}"${due}}`;
      try {
        const { stderr } = await this.runner('osascript', ['-e', script]);
        if (stderr.trim()) throw new Error(stderr.trim());
        input.onItemExported?.(it.id);
        exported += 1;
      } catch (e) {
        failures.push(`${it.id}: ${String(e)}`);
      }
    }
    if (failures.length > 0 && exported === 0) {
      throw new Error(`Reminders export failed: ${failures.join('; ')}`);
    }
    const suffix = failures.length > 0 ? ` (${failures.length} failed)` : '';
    return `${exported} reminders added to "${this.listName}"${suffix}`;
  }
}
