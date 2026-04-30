// electron/main/splash.ts
//
// Frameless splash window shown the instant Electron's `whenReady`
// fires, before the rest of the main-process initialization runs.
// Cold launch can take a few seconds (db open, repo construction,
// IPC handler registration, library watcher start, sidecar handle
// creation) — without the splash the user clicks the dock icon and
// stares at the desktop wondering whether anything happened.
//
// The HTML is embedded as a data URL so there's nothing to package
// or resolve at runtime; the file works identically in dev
// (`npm run dev`) and inside the .app bundle.

import { BrowserWindow, screen } from 'electron';

const SPLASH_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>MeetingNotes</title>
  <style>
    :root { color-scheme: light dark; }
    html, body {
      margin: 0;
      height: 100%;
      width: 100%;
      overflow: hidden;
      background: transparent;
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif;
      -webkit-user-select: none;
      user-select: none;
      cursor: default;
    }
    .card {
      position: fixed;
      inset: 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 18px;
      padding: 32px;
      box-sizing: border-box;
      background: #ffffff;
      border-radius: 14px;
      box-shadow: 0 30px 60px -20px rgba(0,0,0,0.25),
                  0 0 0 1px rgba(15,23,42,0.06);
      -webkit-app-region: drag;  /* the whole splash is draggable */
    }
    @media (prefers-color-scheme: dark) {
      .card {
        background: #1c1917;
        box-shadow: 0 30px 60px -20px rgba(0,0,0,0.6),
                    0 0 0 1px rgba(255,255,255,0.06);
      }
      .product { color: #fafaf9; }
      .status { color: #a8a29e; }
    }
    .logo {
      width: 72px;
      height: 72px;
      border-radius: 18px;
      background: linear-gradient(135deg, #6366f1, #8b5cf6);
      box-shadow: 0 10px 24px -8px rgba(99,102,241,0.55);
      animation: pulse 2.4s ease-in-out infinite;
    }
    @keyframes pulse {
      0%, 100% { transform: scale(1); opacity: 1; }
      50%      { transform: scale(0.96); opacity: 0.85; }
    }
    .product {
      font-size: 17px;
      font-weight: 600;
      letter-spacing: -0.01em;
      color: #1c1917;
      margin: 0;
    }
    .status {
      font-size: 12px;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      color: #78716c;
      display: inline-flex;
      align-items: center;
      gap: 8px;
    }
    .dot {
      width: 6px;
      height: 6px;
      border-radius: 999px;
      background: #6366f1;
      animation: blink 1.2s ease-in-out infinite;
    }
    .dot:nth-child(2) { animation-delay: 0.15s; }
    .dot:nth-child(3) { animation-delay: 0.30s; }
    @keyframes blink {
      0%, 80%, 100% { opacity: 0.25; }
      40%           { opacity: 1; }
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo" aria-hidden="true"></div>
    <h1 class="product">MeetingNotes</h1>
    <div class="status" role="status" aria-live="polite">
      <span class="dot"></span>
      <span class="dot"></span>
      <span class="dot"></span>
      <span style="margin-left: 4px;">Loading</span>
    </div>
  </div>
</body>
</html>`;

const SPLASH_WIDTH = 360;
const SPLASH_HEIGHT = 240;

export interface Splash {
  window: BrowserWindow;
  close: () => void;
}

/** Open the splash window immediately. The data-URL load is
 *  synchronous from the user's perspective — the window paints in
 *  the same tick the BrowserWindow constructor returns. Caller is
 *  responsible for calling `close()` once the real window is up. */
export function createSplash(): Splash {
  const display = screen.getPrimaryDisplay().workArea;
  const x = Math.round(display.x + (display.width  - SPLASH_WIDTH)  / 2);
  const y = Math.round(display.y + (display.height - SPLASH_HEIGHT) / 2);

  const win = new BrowserWindow({
    width: SPLASH_WIDTH,
    height: SPLASH_HEIGHT,
    x, y,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    skipTaskbar: false,
    alwaysOnTop: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // No preload — splash needs nothing from main.
    },
  });

  void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(SPLASH_HTML)}`);
  // Show as soon as the renderer paints to avoid the white-then-content
  // flicker that happens if we show before first paint.
  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) win.show();
  });

  return {
    window: win,
    close: () => {
      if (win.isDestroyed()) return;
      // Brief fade by skipping show animations — destroy directly.
      // Closing early in the lifecycle (before ready-to-show) is safe;
      // Electron tears the window down regardless.
      try {
        win.destroy();
      } catch { /* best-effort */ }
    },
  };
}
