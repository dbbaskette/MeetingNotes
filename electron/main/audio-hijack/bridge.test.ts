import { describe, it, expect, vi } from 'vitest';
import { AudioHijackBridge } from './bridge';

describe('AudioHijackBridge', () => {
  it('startSession issues the expected AppleScript tell', async () => {
    const runner = vi.fn(async () => ({ stdout: '', stderr: '' }));
    const b = new AudioHijackBridge({ runner });
    await b.startSession('Meeting');
    expect(runner).toHaveBeenCalled();
    const [cmd, args] = runner.mock.calls[0]!;
    expect(cmd).toBe('osascript');
    expect((args as string[]).some((a) => a.includes('start session "Meeting"'))).toBe(true);
  });

  it('throws friendly error if stderr non-empty', async () => {
    const runner = vi.fn(async () => ({ stdout: '', stderr: 'Audio Hijack is not running' }));
    const b = new AudioHijackBridge({ runner });
    await expect(b.startSession('x')).rejects.toThrow(/Audio Hijack/);
  });
});
