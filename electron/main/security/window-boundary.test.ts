import { describe, expect, it, vi } from 'vitest';
import { guardedIpc, installWindowBoundary, isTrustedRendererUrl, safeExternalHttpUrl } from './window-boundary.js';

describe('privileged renderer boundary', () => {
  it('trusts only the exact renderer document while permitting its hash state', () => {
    const expected = 'file:///Applications/MeetingNotes.app/Contents/Resources/app.asar/dist/renderer/index.html';
    expect(isTrustedRendererUrl(`${expected}#meeting/1`, expected)).toBe(true);
    expect(isTrustedRendererUrl(`${expected}?override=1`, expected)).toBe(false);
    expect(isTrustedRendererUrl('https://example.com/', expected)).toBe(false);
    expect(isTrustedRendererUrl('not a URL', expected)).toBe(false);
  });

  it('accepts only credential-free HTTP(S) URLs for the system browser', () => {
    expect(safeExternalHttpUrl('https://example.com/path?q=1')).toBe('https://example.com/path?q=1');
    expect(safeExternalHttpUrl('http://example.com/')).toBe('http://example.com/');
    for (const value of ['file:///tmp/data', 'javascript:alert(1)', 'https://user:pass@example.com/', 'bad']) {
      expect(safeExternalHttpUrl(value)).toBeNull();
    }
  });

  it('denies popup windows and redirects ordinary HTTP(S) navigation externally', async () => {
    let open: ((details: { url: string }) => { action: 'deny' }) | undefined;
    let navigate: ((event: { preventDefault(): void }, url: string) => void) | undefined;
    const external = vi.fn(async () => {});
    installWindowBoundary({
      setWindowOpenHandler: handler => { open = handler; },
      on: (_event, handler) => { navigate = handler; },
    }, 'file:///app/index.html', external);
    expect(open!({ url: 'https://docs.example.test/help' })).toEqual({ action: 'deny' });
    const blocked = { preventDefault: vi.fn() };
    navigate!(blocked, 'https://docs.example.test/help');
    navigate!({ preventDefault: vi.fn() }, 'file:///app/index.html#settings');
    expect(blocked.preventDefault).toHaveBeenCalledOnce();
    expect(external).toHaveBeenCalledTimes(2);
    expect(external).toHaveBeenLastCalledWith('https://docs.example.test/help');
  });

  it('rejects an IPC invocation before its registered handler sees an untrusted sender', () => {
    const handlers = new Map<string, (...args: any[]) => unknown>();
    const raw = { handle: (channel: string, handler: (...args: any[]) => unknown) => handlers.set(channel, handler) };
    const guarded = guardedIpc(raw, event => event.sender.id === 7 && event.senderFrame?.url === 'file:///app/index.html');
    const invoked = vi.fn(() => 'ok'); guarded.handle('read', invoked);
    const handler = handlers.get('read')!;
    expect(handler({ sender: { id: 7 }, senderFrame: { url: 'file:///app/index.html' } })).toBe('ok');
    expect(() => handler({ sender: { id: 8 }, senderFrame: { url: 'https://evil.test/' } })).toThrow('Untrusted IPC sender');
    expect(invoked).toHaveBeenCalledTimes(1);
  });
});
