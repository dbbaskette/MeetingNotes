/** Narrow boundary around the privileged renderer. Remote-generated Markdown
 * may contain links, but it must never navigate the Electron document or gain
 * a second privileged renderer. */
export function isTrustedRendererUrl(actual: string, expected: string): boolean {
  try {
    const a = new URL(actual); const e = new URL(expected);
    a.hash = ''; e.hash = '';
    return a.href === e.href;
  } catch { return false; }
}

export function safeExternalHttpUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch { return null; }
}

interface NavigationEvent { preventDefault(): void }
interface BoundaryWebContents {
  setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' }): void;
  on(event: 'will-navigate', listener: (event: NavigationEvent, url: string) => void): void;
}

export function installWindowBoundary(
  contents: BoundaryWebContents,
  expectedRendererUrl: string,
  openExternal: (url: string) => Promise<unknown>,
): void {
  const external = (value: string): void => {
    const url = safeExternalHttpUrl(value);
    if (url) void openExternal(url).catch(() => {});
  };
  contents.setWindowOpenHandler(({ url }) => {
    if (!isTrustedRendererUrl(url, expectedRendererUrl)) external(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => {
    if (isTrustedRendererUrl(url, expectedRendererUrl)) return;
    event.preventDefault(); external(url);
  });
}

interface InvokeEvent { sender: { id: number }; senderFrame?: { url: string } | null }
type InvokeHandler = (event: InvokeEvent, ...args: unknown[]) => unknown;
interface IpcRegistrar { handle(channel: string, listener: InvokeHandler): void }

export function guardedIpc(
  ipc: IpcRegistrar,
  trusted: (event: InvokeEvent) => boolean,
): IpcRegistrar {
  return {
    handle(channel, listener) {
      ipc.handle(channel, (event, ...args) => {
        if (!trusted(event)) throw new Error('Untrusted IPC sender');
        return listener(event, ...args);
      });
    },
  };
}
