import { describe, it, expect } from 'vitest';
import { buildMenuBarItems, formatElapsed, menuBarStatus, menuBarTitle, type MenuBarState } from './model.js';

const idle: MenuBarState = { recording: null, processingTitle: null, queued: 0, paused: false };
const enabled = (state: MenuBarState): Record<string, boolean> =>
  Object.fromEntries(buildMenuBarItems(state, 0).flatMap((item) => (item.type === 'action' ? [[item.action, item.enabled]] : [])));

describe('formatElapsed', () => {
  it('formats minutes and hours', () => {
    expect(formatElapsed(0)).toBe('0:00');
    expect(formatElapsed(65_000)).toBe('1:05');
    expect(formatElapsed(3_725_000)).toBe('1:02:05');
    expect(formatElapsed(-500)).toBe('0:00');
  });
});

describe('menu-bar title and status', () => {
  it('is quiet when idle', () => {
    expect(menuBarTitle(idle, 1000)).toBe('');
    expect(menuBarStatus(idle, 1000)).toBe('Ready');
  });

  it('shows elapsed time while recording', () => {
    const state = { ...idle, recording: { label: 'Zoom', startedAt: 1_000 } };
    expect(menuBarTitle(state, 126_000)).toBe(' 2:05');
    expect(menuBarStatus(state, 126_000)).toBe('Recording Zoom · 2:05');
  });

  it('prefers recording over processing, then shows the queue', () => {
    const processing = { ...idle, processingTitle: 'Quarterly planning review', queued: 2 };
    expect(menuBarStatus(processing, 0)).toBe('Processing “Quarterly planning review” · 2 queued');
    expect(menuBarStatus({ ...processing, recording: { label: 'Zoom', startedAt: 0 } }, 5000)).toMatch(/^Recording Zoom/);
    expect(menuBarStatus({ ...idle, paused: true, queued: 3 }, 0)).toBe('Queue paused · 3 waiting');
  });

  it('clips long titles', () => {
    const status = menuBarStatus({ ...idle, processingTitle: 'x'.repeat(200) }, 0);
    expect(status.length).toBeLessThan(60);
    expect(status).toContain('…');
  });
});

describe('buildMenuBarItems', () => {
  it('offers start actions only when idle and stop only when recording', () => {
    expect(enabled(idle)).toMatchObject({ 'record-system': true, 'record-choose': true, stop: false });
    expect(enabled({ ...idle, recording: { label: 'Zoom', startedAt: 0 } }))
      .toMatchObject({ 'record-system': false, 'record-choose': false, stop: true });
  });

  it('labels the queue toggle by its effect', () => {
    const label = (state: MenuBarState): string | undefined =>
      buildMenuBarItems(state, 0).flatMap((i) => (i.type === 'action' && i.action === 'toggle-queue' ? [i.label] : []))[0];
    expect(label(idle)).toBe('Pause Processing');
    expect(label({ ...idle, paused: true })).toBe('Resume Processing');
  });

  it('always offers the window and quit', () => {
    expect(enabled({ ...idle, recording: { label: 'Zoom', startedAt: 0 } })).toMatchObject({ 'open-window': true, quit: true });
  });
});
