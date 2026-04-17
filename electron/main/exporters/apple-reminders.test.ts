import { describe, it, expect, vi } from 'vitest';
import { AppleRemindersExporter } from './apple-reminders';

describe('AppleRemindersExporter', () => {
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
    expect(runner).toHaveBeenCalledTimes(1);
    const [cmd, args] = runner.mock.calls[0]!;
    expect(cmd).toBe('osascript');
    expect((args as string[]).join(' ')).toContain('do A');
  });
});
