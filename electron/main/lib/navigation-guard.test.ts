import { describe, it, expect, vi } from 'vitest';
import { guardWebContents, installNavigationGuard, isSafeExternalUrl, isSameDocument } from './navigation-guard.js';

const APP_URL = 'file:///Applications/MeetingNotes.app/Contents/Resources/app.asar/dist/renderer/index.html';

function fakeContents(current = APP_URL) {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  let openHandler: ((details: { url: string }) => { action: 'deny' }) | undefined;
  const contents = {
    getURL: () => current,
    on: (event: string, listener: (...args: unknown[]) => void) => { listeners.set(event, listener); },
    setWindowOpenHandler: (handler: (details: { url: string }) => { action: 'deny' }) => { openHandler = handler; },
  };
  const navigate = (event: string, url?: string) => {
    const preventDefault = vi.fn();
    listeners.get(event)!({ preventDefault }, url);
    return preventDefault;
  };
  return { contents, navigate, open: (url: string) => openHandler!({ url }) };
}

describe('isSafeExternalUrl', () => {
  it('allows ordinary web and mail links', () => {
    expect(isSafeExternalUrl('https://example.com/a?b=1')).toBe(true);
    expect(isSafeExternalUrl('http://example.com')).toBe(true);
    expect(isSafeExternalUrl('mailto:someone@example.com')).toBe(true);
  });

  it('rejects local, script and app schemes', () => {
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,hi', 'meetingnotes://record',
      'smb://host/share', 'x-apple.systempreferences:com.apple.preference.security', 'not a url', '']) {
      expect(isSafeExternalUrl(url), url).toBe(false);
    }
  });

  it('allows System Settings deep links only on request', () => {
    const url = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone';
    expect(isSafeExternalUrl(url, { allowSystemSettings: true })).toBe(true);
    expect(isSafeExternalUrl('file:///etc/passwd', { allowSystemSettings: true })).toBe(false);
  });
});

describe('isSameDocument', () => {
  it('matches reloads and fragment or query changes only', () => {
    expect(isSameDocument(APP_URL, APP_URL)).toBe(true);
    expect(isSameDocument(`${APP_URL}#meeting-speakers`, APP_URL)).toBe(true);
    expect(isSameDocument('http://localhost:5174/?x=1', 'http://localhost:5174/')).toBe(true);
    expect(isSameDocument('file:///Users/me/evil.html', APP_URL)).toBe(false);
    expect(isSameDocument('http://localhost:5175/', 'http://localhost:5174/')).toBe(false);
    expect(isSameDocument('https://example.com', APP_URL)).toBe(false);
  });
});

describe('guardWebContents', () => {
  it('cancels navigation to a web link and opens it in the browser', () => {
    const { contents, navigate } = fakeContents();
    const openExternal = vi.fn();
    guardWebContents(contents, { openExternal });
    const preventDefault = navigate('will-navigate', 'https://example.com/notes');
    expect(preventDefault).toHaveBeenCalled();
    expect(openExternal).toHaveBeenCalledWith('https://example.com/notes');
  });

  it('cancels unsafe navigation without opening anything, logging only the scheme', () => {
    const { contents, navigate } = fakeContents();
    const openExternal = vi.fn(), log = vi.fn();
    guardWebContents(contents, { openExternal, log });
    expect(navigate('will-navigate', 'file:///Users/me/secret-plan.html')).toHaveBeenCalled();
    expect(navigate('will-redirect', 'javascript:alert(1)')).toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('navigation:blocked', { via: 'will-navigate', scheme: 'file:' });
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret-plan');
  });

  it('lets the app reload its own page', () => {
    const { contents, navigate } = fakeContents();
    const openExternal = vi.fn();
    guardWebContents(contents, { openExternal });
    expect(navigate('will-navigate', APP_URL)).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('never creates a window, and blocks webviews', () => {
    const { contents, navigate, open } = fakeContents();
    const openExternal = vi.fn();
    guardWebContents(contents, { openExternal });
    expect(open('https://docs.google.com/document/d/1')).toEqual({ action: 'deny' });
    expect(openExternal).toHaveBeenCalledWith('https://docs.google.com/document/d/1');
    expect(open('file:///tmp/x.html')).toEqual({ action: 'deny' });
    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(navigate('will-attach-webview')).toHaveBeenCalled();
  });

  it('survives a rejected openExternal', async () => {
    const { contents, navigate } = fakeContents();
    guardWebContents(contents, { openExternal: async () => { throw new Error('no handler'); } });
    navigate('will-navigate', 'https://example.com');
    await new Promise((resolve) => setImmediate(resolve));
  });
});

describe('installNavigationGuard', () => {
  it('guards every webContents the app creates', () => {
    let created: ((event: unknown, contents: unknown) => void) | undefined;
    const app = { on: (_event: string, listener: (event: unknown, contents: unknown) => void) => { created = listener; } };
    const openExternal = vi.fn();
    installNavigationGuard(app as never, { openExternal });
    const { contents, navigate } = fakeContents();
    created!({}, contents);
    navigate('will-navigate', 'https://example.com');
    expect(openExternal).toHaveBeenCalledWith('https://example.com');
  });
});
