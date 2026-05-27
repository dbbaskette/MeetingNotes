import { describe, it, expect, vi } from 'vitest';
import { SchemeDispatcher } from './dispatcher.js';

function makeDeps(over: Partial<Parameters<typeof makeDepsImpl>[0]> = {}): ReturnType<typeof makeDepsImpl> {
  return makeDepsImpl(over);
}

function makeDepsImpl(over: {
  openSessions?: { id: string; targetLabel: string }[];
  sources?: { pid: number; bundleId: string | null; name: string | null; isMeetingApp: boolean; isRunningOutput: boolean }[];
  meeting?: { id: string; title: string } | null;
  startResult?: { sessionId: string; outputPath: string };
  startThrow?: Error;
  stopThrow?: Error;
}) {
  const notify = vi.fn();
  const focusMainWindow = vi.fn();
  const emitOpenMeeting = vi.fn();
  const start = vi.fn(async () => {
    if (over.startThrow) throw over.startThrow;
    return over.startResult ?? { sessionId: 'sess-1', outputPath: '/tmp/x.m4a' };
  });
  const stop = vi.fn(async () => {
    if (over.stopThrow) throw over.stopThrow;
  });
  const findOpen = vi.fn(() => over.openSessions ?? []);
  const enumeratorList = vi.fn(async () => over.sources ?? []);
  const findById = vi.fn(() => over.meeting ?? null);
  const logger = { info: vi.fn(), error: vi.fn() };
  const dispatcher = new SchemeDispatcher({
    recordingManager: { start, stop } as never,
    appEnumerator: { list: enumeratorList } as never,
    recordingSessionsRepo: { findOpen } as never,
    meetings: { findById } as never,
    emitOpenMeeting,
    notify,
    focusMainWindow,
    logger,
  });
  return { dispatcher, notify, focusMainWindow, emitOpenMeeting, start, stop, findOpen, enumeratorList, findById, logger };
}

describe('SchemeDispatcher', () => {
  describe('record', () => {
    it('starts a system-audio recording for source=all', async () => {
      const d = makeDeps();
      const r = await d.dispatcher.dispatch('meetingnotes://record');
      expect(r.ok).toBe(true);
      expect(d.start).toHaveBeenCalledWith({ targetPid: 'system', targetLabel: 'System Audio', mic: true });
      expect(d.focusMainWindow).toHaveBeenCalled();
    });

    it('resolves source=zoom to the live zoom pid', async () => {
      const d = makeDeps({
        sources: [
          { pid: 7777, bundleId: 'us.zoom.xos', name: 'zoom.us', isMeetingApp: true, isRunningOutput: true },
        ],
      });
      const r = await d.dispatcher.dispatch('meetingnotes://record?source=zoom');
      expect(r.ok).toBe(true);
      expect(d.start).toHaveBeenCalledWith({ targetPid: 7777, targetLabel: 'zoom.us', mic: true });
    });

    it('resolves a bundle id directly', async () => {
      const d = makeDeps({
        sources: [
          { pid: 9000, bundleId: 'com.microsoft.teams2', name: 'Microsoft Teams', isMeetingApp: true, isRunningOutput: true },
        ],
      });
      const r = await d.dispatcher.dispatch('meetingnotes://record?source=com.microsoft.teams2');
      expect(r.ok).toBe(true);
      expect(d.start).toHaveBeenCalledWith({ targetPid: 9000, targetLabel: 'Microsoft Teams', mic: true });
    });

    it('refuses to start when a recording is already active', async () => {
      const d = makeDeps({ openSessions: [{ id: 'abc', targetLabel: 'Already going' }] });
      const r = await d.dispatcher.dispatch('meetingnotes://record');
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/already recording/i);
      expect(d.start).not.toHaveBeenCalled();
      expect(d.notify).toHaveBeenCalled();
    });

    it('fails fast when source has no live audio process', async () => {
      const d = makeDeps({ sources: [] });
      const r = await d.dispatcher.dispatch('meetingnotes://record?source=zoom');
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/isn't producing audio/i);
      expect(d.start).not.toHaveBeenCalled();
    });

    it('fails when source app is idle (registered but not playing)', async () => {
      const d = makeDeps({
        sources: [
          { pid: 7777, bundleId: 'us.zoom.xos', name: 'zoom.us', isMeetingApp: true, isRunningOutput: false },
        ],
      });
      const r = await d.dispatcher.dispatch('meetingnotes://record?source=zoom');
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/idle/i);
    });

    it('rejects an unknown keyword source', async () => {
      const d = makeDeps();
      const r = await d.dispatcher.dispatch('meetingnotes://record?source=skype');
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/unknown source/i);
    });

    it('writes an audit log entry on every dispatch', async () => {
      const d = makeDeps();
      await d.dispatcher.dispatch('meetingnotes://record');
      expect(d.logger.info).toHaveBeenCalledWith('url-scheme:dispatch', expect.objectContaining({
        url: 'meetingnotes://record',
      }));
    });

    it('reports start failures as user-visible errors', async () => {
      const d = makeDeps({ startThrow: new Error('helper not found') });
      const r = await d.dispatcher.dispatch('meetingnotes://record');
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/helper not found/);
      expect(d.notify).toHaveBeenCalled();
    });
  });

  describe('stop', () => {
    it('stops the active recording', async () => {
      const d = makeDeps({ openSessions: [{ id: 'sess-x', targetLabel: 'Zoom' }] });
      const r = await d.dispatcher.dispatch('meetingnotes://stop');
      expect(r.ok).toBe(true);
      expect(d.stop).toHaveBeenCalledWith('sess-x');
    });

    it('no-ops with a notification when nothing is recording', async () => {
      const d = makeDeps();
      const r = await d.dispatcher.dispatch('meetingnotes://stop');
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/no active recording/i);
      expect(d.stop).not.toHaveBeenCalled();
    });
  });

  describe('open', () => {
    it('emits the focus event for a known meeting id', async () => {
      const d = makeDeps({ meeting: { id: 'm1', title: 'Standup' } });
      const r = await d.dispatcher.dispatch('meetingnotes://open?id=m1');
      expect(r.ok).toBe(true);
      expect(d.emitOpenMeeting).toHaveBeenCalledWith('m1');
    });

    it('refuses to focus an unknown meeting', async () => {
      const d = makeDeps({ meeting: null });
      const r = await d.dispatcher.dispatch('meetingnotes://open?id=does-not-exist');
      expect(r.ok).toBe(false);
      expect(d.emitOpenMeeting).not.toHaveBeenCalled();
    });
  });

  describe('errors', () => {
    it('reports malformed URLs without crashing', async () => {
      const d = makeDeps();
      const r = await d.dispatcher.dispatch('meetingnotes://launch');
      expect(r.ok).toBe(false);
      expect(d.start).not.toHaveBeenCalled();
    });
  });
});
