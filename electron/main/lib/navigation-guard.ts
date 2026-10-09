// electron/main/lib/navigation-guard.ts
//
// The renderer displays text the app did not write: LLM-generated notes,
// transcripts and export results. A link in that text must never navigate an
// app window (the preload would attach to whatever loaded there) or open a
// new Electron window. Every navigation away from the app's own page is
// cancelled, and ordinary web links are handed to the default browser (#249).

/** Schemes a clicked link may open outside the app. */
const BROWSER_SCHEMES = new Set(['https:', 'http:', 'mailto:']);

/** True for links that are safe to pass to shell.openExternal. Deep links
 *  into System Settings are allowed only for callers that ask for them
 *  (the onboarding permission buttons), never for links in content. */
export function isSafeExternalUrl(url: string, opts: { allowSystemSettings?: boolean } = {}): boolean {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return false; }
  if (BROWSER_SCHEMES.has(parsed.protocol)) return true;
  return opts.allowSystemSettings === true && parsed.protocol === 'x-apple.systempreferences:';
}

/** A reload or in-page move: same document, ignoring query and fragment. */
export function isSameDocument(target: string, current: string): boolean {
  try {
    const a = new URL(target), b = new URL(current);
    return a.protocol === b.protocol && a.host === b.host && a.pathname === b.pathname;
  } catch { return false; }
}

interface GuardedContents {
  getURL(): string;
  on(event: 'will-navigate' | 'will-redirect', listener: (event: { preventDefault(): void }, url: string) => void): unknown;
  on(event: 'will-attach-webview', listener: (event: { preventDefault(): void }) => void): unknown;
  setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' }): void;
}

export interface NavigationGuardDeps {
  openExternal: (url: string) => void | Promise<void>;
  log?: (msg: string, data: Record<string, unknown>) => void;
}

/** Applies the policy to one webContents. */
export function guardWebContents(contents: GuardedContents, deps: NavigationGuardDeps): void {
  const leave = (url: string, via: string): void => {
    if (isSafeExternalUrl(url)) {
      void Promise.resolve(deps.openExternal(url)).catch(() => {});
    } else {
      // Log the scheme only: the rest of a blocked URL may carry content.
      let scheme = 'invalid';
      try { scheme = new URL(url).protocol; } catch { /* keep 'invalid' */ }
      deps.log?.('navigation:blocked', { via, scheme });
    }
  };
  const onNavigate = (via: string) => (event: { preventDefault(): void }, url: string): void => {
    if (isSameDocument(url, contents.getURL())) return;
    event.preventDefault();
    leave(url, via);
  };
  contents.on('will-navigate', onNavigate('will-navigate'));
  contents.on('will-redirect', onNavigate('will-redirect'));
  contents.on('will-attach-webview', (event) => { event.preventDefault(); });
  contents.setWindowOpenHandler(({ url }) => { leave(url, 'window-open'); return { action: 'deny' }; });
}

/** Guards every webContents the app ever creates, including windows added
 *  later, so no new surface can forget to opt in. */
export function installNavigationGuard(
  app: { on(event: 'web-contents-created', listener: (event: unknown, contents: GuardedContents) => void): unknown },
  deps: NavigationGuardDeps,
): void {
  app.on('web-contents-created', (_event, contents) => guardWebContents(contents, deps));
}
