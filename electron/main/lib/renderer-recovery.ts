// electron/main/lib/renderer-recovery.ts
//
// A renderer that crashes or hangs leaves a dead window with no way back
// short of quitting. Recording and processing live in the main process and
// are unaffected, so the right recovery is to offer a reload (#251).

export interface RecoverableWindow {
  isDestroyed(): boolean;
  reload(): void;
  webContents: {
    on(event: 'render-process-gone', listener: (event: unknown, details: { reason: string; exitCode?: number }) => void): unknown;
    on(event: 'unresponsive' | 'responsive', listener: () => void): unknown;
  };
}

export interface RecoveryDeps {
  /** Shows a two-button prompt; resolves true when the user chose Reload. */
  askReload: (message: string, detail: string) => Promise<boolean>;
  log: (msg: string, data: Record<string, unknown>) => void;
}

export function installRendererRecovery(win: RecoverableWindow, deps: RecoveryDeps): void {
  let prompting = false;
  const offerReload = async (message: string, detail: string): Promise<void> => {
    if (prompting || win.isDestroyed()) return;
    prompting = true;
    try {
      if (await deps.askReload(message, detail) && !win.isDestroyed()) win.reload();
    } finally { prompting = false; }
  };

  win.webContents.on('render-process-gone', (_event, details) => {
    // 'clean-exit' is a normal close or reload, not a failure.
    if (details.reason === 'clean-exit') return;
    deps.log('window:render-process-gone', { reason: details.reason, exitCode: details.exitCode ?? null });
    void offerReload(
      'The MeetingNotes window stopped working',
      'Recording and processing continue in the background. Reload the window to carry on.',
    );
  });

  win.webContents.on('unresponsive', () => {
    deps.log('window:unresponsive', {});
    void offerReload(
      'The MeetingNotes window is not responding',
      'Recording and processing continue in the background. You can wait, or reload the window.',
    );
  });
}
