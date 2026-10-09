import { describe, it, expect, vi } from 'vitest';
import { installRendererRecovery, type RecoverableWindow } from './renderer-recovery.js';

function fakeWindow() {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const win = {
    destroyed: false,
    reload: vi.fn(),
    isDestroyed() { return this.destroyed; },
    webContents: { on: (event: string, listener: (...args: unknown[]) => void) => { listeners.set(event, listener); } },
  };
  return { win, emit: (event: string, ...args: unknown[]) => listeners.get(event)!(...args) };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('installRendererRecovery', () => {
  it('logs a crash and reloads when the user accepts', async () => {
    const { win, emit } = fakeWindow();
    const log = vi.fn();
    installRendererRecovery(win as unknown as RecoverableWindow, { askReload: async () => true, log });
    emit('render-process-gone', {}, { reason: 'crashed', exitCode: 5 });
    await flush();
    expect(log).toHaveBeenCalledWith('window:render-process-gone', { reason: 'crashed', exitCode: 5 });
    expect(win.reload).toHaveBeenCalledTimes(1);
  });

  it('ignores a clean exit', async () => {
    const { win, emit } = fakeWindow();
    const askReload = vi.fn(async () => true);
    installRendererRecovery(win as unknown as RecoverableWindow, { askReload, log: vi.fn() });
    emit('render-process-gone', {}, { reason: 'clean-exit' });
    await flush();
    expect(askReload).not.toHaveBeenCalled();
    expect(win.reload).not.toHaveBeenCalled();
  });

  it('does not reload when the user declines or the window is gone', async () => {
    const declined = fakeWindow();
    installRendererRecovery(declined.win as unknown as RecoverableWindow, { askReload: async () => false, log: vi.fn() });
    declined.emit('unresponsive');
    await flush();
    expect(declined.win.reload).not.toHaveBeenCalled();

    const closed = fakeWindow();
    installRendererRecovery(closed.win as unknown as RecoverableWindow, {
      askReload: async () => { closed.win.destroyed = true; return true; }, log: vi.fn(),
    });
    closed.emit('unresponsive');
    await flush();
    expect(closed.win.reload).not.toHaveBeenCalled();
  });

  it('shows one prompt at a time', async () => {
    const { win, emit } = fakeWindow();
    let release!: (reload: boolean) => void;
    const askReload = vi.fn(() => new Promise<boolean>((resolve) => { release = resolve; }));
    installRendererRecovery(win as unknown as RecoverableWindow, { askReload, log: vi.fn() });
    emit('unresponsive');
    emit('unresponsive');
    expect(askReload).toHaveBeenCalledTimes(1);
    release(false);
    await flush();
    emit('unresponsive');
    expect(askReload).toHaveBeenCalledTimes(2);
  });
});
