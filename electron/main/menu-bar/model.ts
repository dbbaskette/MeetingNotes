// electron/main/menu-bar/model.ts
//
// What the menu-bar item shows, as plain data (#253). Electron-free so the
// labels and enabled states are unit-testable; controller.ts turns this into
// a real Tray.

export interface MenuBarState {
  /** The open capture, if any. `startedAt` is epoch milliseconds. */
  recording: { label: string; startedAt: number } | null;
  /** Title of the meeting being processed, if any. */
  processingTitle: string | null;
  queued: number;
  paused: boolean;
}

export type MenuBarAction =
  | 'record-system'
  | 'record-choose'
  | 'stop'
  | 'open-window'
  | 'toggle-queue'
  | 'quit';

export type MenuBarItem =
  | { type: 'separator' }
  | { type: 'status'; label: string }
  | { type: 'action'; action: MenuBarAction; label: string; enabled: boolean };

/** `m:ss` under an hour, `h:mm:ss` beyond. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Text beside the icon. Empty when idle so the item stays small. */
export function menuBarTitle(state: MenuBarState, now: number): string {
  return state.recording ? ` ${formatElapsed(now - state.recording.startedAt)}` : '';
}

function clip(text: string, max = 48): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function menuBarStatus(state: MenuBarState, now: number): string {
  if (state.recording) return `Recording ${clip(state.recording.label, 32)} · ${formatElapsed(now - state.recording.startedAt)}`;
  if (state.processingTitle) {
    const more = state.queued > 0 ? ` · ${state.queued} queued` : '';
    return `Processing “${clip(state.processingTitle, 32)}”${more}`;
  }
  if (state.paused && state.queued > 0) return `Queue paused · ${state.queued} waiting`;
  return 'Ready';
}

export function buildMenuBarItems(state: MenuBarState, now: number): MenuBarItem[] {
  const recording = state.recording !== null;
  return [
    { type: 'status', label: menuBarStatus(state, now) },
    { type: 'separator' },
    // Starting while a capture is open is refused by the recorder with its own
    // guidance; disabling here just avoids offering it.
    { type: 'action', action: 'record-system', label: 'Record All System Audio', enabled: !recording },
    { type: 'action', action: 'record-choose', label: 'Choose What to Record…', enabled: !recording },
    { type: 'action', action: 'stop', label: 'Stop Recording', enabled: recording },
    { type: 'separator' },
    { type: 'action', action: 'toggle-queue', label: state.paused ? 'Resume Processing' : 'Pause Processing', enabled: true },
    { type: 'action', action: 'open-window', label: 'Open MeetingNotes', enabled: true },
    { type: 'separator' },
    { type: 'action', action: 'quit', label: 'Quit MeetingNotes', enabled: true },
  ];
}
