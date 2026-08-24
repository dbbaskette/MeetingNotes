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
      // AppleScript's `date "2026-01-15"` literal does NOT parse ISO dates —
      // on an en_US Mac it silently yields October 12183 and the reminder
      // never alerts. Build the date from numeric components instead; the
      // ISO_DATE regex guarantees the split below is three integers.
      let script: string;
      if (it.dueDate && ISO_DATE.test(it.dueDate)) {
        const [y, mo, d] = it.dueDate.split('-').map(Number);
        script =
          `set dueDate to current date\n` +
          `set day of dueDate to 1\n` +
          `set year of dueDate to ${y}\n` +
          `set month of dueDate to ${mo}\n` +
          `set day of dueDate to ${d}\n` +
          `set time of dueDate to 9 * hours\n` +
          `tell application "Reminders" to make new reminder at list "${list}" with properties {name:"${name}", remind me date: dueDate}`;
      } else {
        script = `tell application "Reminders" to make new reminder at list "${list}" with properties {name:"${name}"}`;
      }
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
