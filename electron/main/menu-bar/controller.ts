// electron/main/menu-bar/controller.ts
//
// The macOS menu-bar item (#253): shows whether MeetingNotes is recording or
// processing and lets the user start or stop a recording without finding the
// window. All behaviour is injected; what it shows comes from model.ts.

import { Menu, Tray, nativeImage, type MenuItemConstructorOptions } from 'electron';
import { buildMenuBarItems, menuBarTitle, type MenuBarAction, type MenuBarState } from './model.js';

export interface MenuBarDeps {
  getState: () => MenuBarState;
  onAction: (action: MenuBarAction) => void;
}

export class MenuBarController {
  private tray: Tray | null = null;
  private timer: NodeJS.Timeout | null = null;
  private hasIcon = false;

  constructor(private readonly deps: MenuBarDeps) {}

  setVisible(visible: boolean): void {
    if (visible) this.show(); else this.hide();
  }

  /** Call whenever recording or processing state changes. */
  refresh(): void {
    if (!this.tray) return;
    const state = this.deps.getState();
    const title = menuBarTitle(state, Date.now());
    // Without an icon the item would be invisible when idle.
    this.tray.setTitle(title || (this.hasIcon ? '' : 'MN'));
    // Tick the elapsed time only while there is something to count.
    if (state.recording && !this.timer) this.timer = setInterval(() => this.refresh(), 1000);
    if (!state.recording && this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  private show(): void {
    if (this.tray) return;
    // A system template image adapts to light and dark menu bars and needs no
    // bundled asset.
    let icon = nativeImage.createEmpty();
    try { icon = nativeImage.createFromNamedImage('NSImageNameTouchBarRecordStartTemplate').resize({ height: 16 }); }
    catch { /* fall back to a text title */ }
    this.hasIcon = !icon.isEmpty();
    if (this.hasIcon) icon.setTemplateImage(true);
    this.tray = new Tray(icon);
    this.tray.setToolTip('MeetingNotes');
    // Build the menu when it is opened so its status line and enabled states
    // are current, rather than a snapshot from the last state change.
    const open = (): void => { this.tray?.popUpContextMenu(this.buildMenu()); };
    this.tray.on('click', open);
    this.tray.on('right-click', open);
    this.refresh();
  }

  private hide(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.tray?.destroy();
    this.tray = null;
  }

  private buildMenu(): Menu {
    const template: MenuItemConstructorOptions[] = buildMenuBarItems(this.deps.getState(), Date.now()).map((item) => {
      if (item.type === 'separator') return { type: 'separator' };
      if (item.type === 'status') return { label: item.label, enabled: false };
      const { action } = item;
      return { label: item.label, enabled: item.enabled, click: () => this.deps.onAction(action) };
    });
    return Menu.buildFromTemplate(template);
  }
}
