// electron/main/menu.ts
//
// Custom application menu so MeetingNotes' primary actions (Record,
// Search, Library/Weekly/Settings) get accelerator keys and become
// discoverable in the menu bar — not just hidden behind buttons inside
// the window.
//
// Most items emit window-level CustomEvents that the renderer listens
// for. This keeps menu wiring out of the renderer's import graph and
// avoids round-trip IPC for actions that are pure UI navigation.
// Recording itself flows through the existing api.recording.start —
// the Cmd+R menu item just dispatches `mn:toggle-record`, the same
// event the keyboard listener in App.tsx fires.

import { app, BrowserWindow, Menu, type MenuItemConstructorOptions } from 'electron';

function emit(channel: string): void {
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send('mn:menu-action', channel);
  }
}

export function buildAppMenu(): Menu {
  const isMac = process.platform === 'darwin';

  const fileMenu: MenuItemConstructorOptions = {
    label: 'File',
    submenu: [
      {
        label: 'New Recording…',
        accelerator: 'CmdOrCtrl+R',
        click: () => emit('toggle-record'),
      },
      { type: 'separator' },
      {
        label: 'Close Window',
        role: 'close',
      },
    ],
  };

  const viewMenu: MenuItemConstructorOptions = {
    label: 'View',
    submenu: [
      { label: 'Library', accelerator: 'CmdOrCtrl+1', click: () => emit('view-library') },
      { label: 'Weekly Summary', accelerator: 'CmdOrCtrl+2', click: () => emit('view-weekly') },
      { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => emit('view-settings') },
      { type: 'separator' },
      { label: 'Search…', accelerator: 'CmdOrCtrl+K', click: () => emit('open-search') },
      { type: 'separator' },
      { role: 'reload' },
      { role: 'toggleDevTools' },
      { type: 'separator' },
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
    ],
  };

  const editMenu: MenuItemConstructorOptions = {
    label: 'Edit',
    submenu: [
      { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
      { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
    ],
  };

  const windowMenu: MenuItemConstructorOptions = {
    label: 'Window',
    role: 'windowMenu',
  };

  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' as const },
        { type: 'separator' as const },
        { label: 'Settings…', accelerator: 'Cmd+,', click: () => emit('view-settings') },
        { type: 'separator' as const },
        { role: 'services' as const },
        { type: 'separator' as const },
        { role: 'hide' as const }, { role: 'hideOthers' as const }, { role: 'unhide' as const },
        { type: 'separator' as const },
        { role: 'quit' as const },
      ],
    } as MenuItemConstructorOptions] : []),
    fileMenu,
    editMenu,
    viewMenu,
    windowMenu,
  ];

  return Menu.buildFromTemplate(template);
}

/** Install the menu globally (macOS) or per-window (other platforms).
 *  Called once during app startup, after `whenReady` resolves. */
export function installAppMenu(): void {
  Menu.setApplicationMenu(buildAppMenu());
}
