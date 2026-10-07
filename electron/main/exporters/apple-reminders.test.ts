import { describe, it, expect, vi } from 'vitest';
import { AppleRemindersExporter } from './apple-reminders.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

async function reminderScript(dueDate: string | null): Promise<string> {
  const runner = vi.fn(async (_cmd: string, _args: string[]) => ({ stdout: '', stderr: '' }));
  await new AppleRemindersExporter({ runner }).export({
    items: [{ id: '1', text: 'Fixture reminder', ownerName: null, dueDate, status: 'open' }],
    meetingTitle: 'Fixture', meetingFolder: '/tmp',
  });
  return runner.mock.calls[1]![1][1]!;
}

describe('AppleRemindersExporter', () => {
  it('builds numeric date components before creating the reminder, at 9am local time', async () => {
    const script = await reminderScript('2028-02-29');
    expect(script).toContain('set day of dueDate to 1\nset year of dueDate to 2028\nset month of dueDate to 2\nset day of dueDate to 29\nset time of dueDate to 9 * hours\n');
    expect(script).toContain('remind me date: dueDate');
    expect(script).not.toContain('date "2028-02-29"');
  });

  it.each([null, 'not-a-date', '01/15/2026'])('omits dates that are not ISO date inputs: %s', async (dueDate) => {
    expect(await reminderScript(dueDate)).not.toContain('remind me date');
  });

  it.runIf(process.platform === 'darwin').each(['2026-01-15', '2026-02-28', '2028-02-29'])('evaluates date-only AppleScript correctly for %s without opening Reminders', async (dueDate) => {
    const script = await reminderScript(dueDate);
    // Execute ONLY the numeric date prefix, never a tell/application command.
    const dateOnly = script.split('tell application')[0]!;
    expect(dateOnly).not.toContain('application');
    const { stdout } = await promisify(execFile)('osascript', ['-e', dateOnly + '\nreturn {year of dueDate, (month of dueDate as integer), day of dueDate, time of dueDate}'], { timeout: 10000 });
    const [year, month, day] = dueDate.split('-').map(Number);
    expect(stdout.trim()).toBe(`${year}, ${month}, ${day}, 32400`);
  });

  it('creates one reminder per item via osascript', async () => {
    const runner = vi.fn(async () => ({ stdout: '', stderr: '' }));
    const exp = new AppleRemindersExporter({ runner, listName: 'MeetingNotes' });
    await exp.export({
      items: [
        { id: '1', text: 'do A', ownerName: 'Dan', dueDate: '2026-04-22', status: 'open' },
        { id: '2', text: 'do B', ownerName: null, dueDate: null, status: 'done' },
      ],
      meetingTitle: 'Q2',
      meetingFolder: '/tmp',
    });
    // 1 ensure-list call + 1 per open item (done items are filtered).
    expect(runner).toHaveBeenCalledTimes(2);
    const [ensureCmd, ensureArgs] = runner.mock.calls[0]!;
    expect(ensureCmd).toBe('osascript');
    expect((ensureArgs as string[]).join(' ')).toContain('exists list');
    const [cmd, args] = runner.mock.calls[1]!;
    expect(cmd).toBe('osascript');
    expect((args as string[]).join(' ')).toContain('do A');
  });
});
