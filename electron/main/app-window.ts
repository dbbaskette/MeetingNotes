import { app, BrowserWindow, dialog } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installRendererRecovery } from './lib/renderer-recovery.js';
import { sanitizeBounds, type WindowBounds } from './lib/window-bounds.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;

// Window-bounds persistence (UX: remember size/position across launches).
// Populated in whenReady() once the settings repo exists; createWindow —
// which is also invoked from the dock-icon 'activate' handler — consults it
// on every window creation. load() returns null when nothing usable is
// saved (first run, garbage row, or the saved position is on a display
// that's no longer attached), in which case the hardcoded defaults apply.
/** Set in whenReady() once the logger exists; createWindow reports renderer
 *  crashes through it. */
let windowLog: ((msg: string, data: Record<string, unknown>) => void) | null = null;

export function setWindowLog(log: (msg: string, data: Record<string, unknown>) => void): void {
  windowLog = log;
}

/** Reports through the window logger once whenReady() has installed it. */
export function logWindow(msg: string, data: Record<string, unknown>): void {
  windowLog?.(msg, data);
}

export type WindowBoundsStore = {
  load: () => WindowBounds | null;
  save: (b: WindowBounds) => void;
};

let windowBoundsStore: WindowBoundsStore | null = null;

export function setWindowBoundsStore(store: WindowBoundsStore): void {
  windowBoundsStore = store;
}

export async function createWindow(backgroundColor = '#fafaf9'): Promise<BrowserWindow> {
  const restored = windowBoundsStore?.load() ?? null;
  const win = new BrowserWindow({
    width: restored?.width ?? 1200,
    height: restored?.height ?? 800,
    // Only pin x/y when restoring — otherwise let macOS center the window.
    ...(restored ? { x: restored.x, y: restored.y } : {}),
    // Keep the window from shrinking to a size where the detail view's
    // fixed-width rails + stage timeline chips would clip content off the
    // right edge. 900×600 still leaves the three-column detail layout
    // readable; below that the renderer's responsive breakpoint collapses
    // the rails below the center pane.
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    backgroundColor,
    // Don't show until the renderer has painted — paired with the splash
    // window, the user sees the loading card the whole time and then the
    // fully-rendered library, never an empty white frame.
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../../preload/electron/preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // Persist bounds on resize/move (debounced — these fire continuously
  // during a drag) and once more on close so the final position always
  // wins even if it landed inside the debounce window.
  if (windowBoundsStore) {
    const store = windowBoundsStore;
    let saveTimer: NodeJS.Timeout | null = null;
    const saveBounds = (): void => {
      if (win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;
      const b = sanitizeBounds(win.getBounds());
      if (b) store.save(b);
    };
    const debouncedSave = (): void => {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(saveBounds, 500);
    };
    win.on('resize', debouncedSave);
    win.on('move', debouncedSave);
    win.on('close', () => {
      if (saveTimer) clearTimeout(saveTimer);
      saveBounds();
    });
  }
  installRendererRecovery(win, {
    log: (msg, data) => windowLog?.(msg, data),
    askReload: async (message, detail) => {
      const { response } = await dialog.showMessageBox(win, {
        type: 'warning', message, detail, buttons: ['Reload', 'Wait'], defaultId: 0, cancelId: 1,
      });
      return response === 0;
    },
  });
  if (isDev) await win.loadURL(process.env.VITE_DEV_URL ?? 'http://localhost:5174');
  else await win.loadFile(path.join(__dirname, '../../renderer/index.html'));
  return win;
}
