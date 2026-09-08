import { describe, it, expect, vi } from 'vitest';
import { AppEnumerator } from './app-enumerator.js';

describe('AppEnumerator', () => {
  it('parses helper output into source list', async () => {
    const helperOutput = JSON.stringify({
      event: 'processes',
      items: [
        { pid: 100, bundle_id: 'us.zoom.xos', name: 'Zoom', is_meeting_app: true, is_running_output: false },
        { pid: 200, bundle_id: 'com.google.Chrome', name: 'Google Chrome', is_meeting_app: false, is_running_output: true },
      ],
    }) + '\n';
    const fakeRunner = vi.fn(async () => ({ stdout: helperOutput, stderr: '' }));
    const e = new AppEnumerator({ helperPath: '/bin/meeting-notes-tap', runner: fakeRunner });

    const sources = await e.list();
    expect(sources).toHaveLength(2);
    expect(sources[0]!.isMeetingApp).toBe(true);
    expect(sources[0]!.name).toBe('Zoom');
    expect(sources[0]!.isRunningOutput).toBe(false);
    expect(sources[1]!.isRunningOutput).toBe(true);
  });

  it('defaults isRunningOutput to true when helper omits the field (older binary)', async () => {
    const helperOutput = JSON.stringify({
      event: 'processes',
      items: [{ pid: 100, name: 'Something', is_meeting_app: false }],
    }) + '\n';
    const fakeRunner = vi.fn(async () => ({ stdout: helperOutput, stderr: '' }));
    const e = new AppEnumerator({ helperPath: '/h', runner: fakeRunner });
    expect((await e.list())[0]!.isRunningOutput).toBe(true);
  });

  it('returns empty list when helper emits no processes line', async () => {
    const fakeRunner = vi.fn(async () => ({ stdout: '\n', stderr: '' }));
    const e = new AppEnumerator({ helperPath: '/h', runner: fakeRunner });
    expect(await e.list()).toEqual([]);
  });

  it('collapses helper processes into one row per owning app, preferring the audible pid', async () => {
    const helperOutput = JSON.stringify({
      event: 'processes',
      items: [
        { pid: 301, name: 'Google Chrome Helper', is_running_output: false, is_user_app: true, owner_pid: 300, owner_name: 'Google Chrome' },
        { pid: 302, name: 'Google Chrome Helper (GPU)', is_running_output: true, is_user_app: true, owner_pid: 300, owner_name: 'Google Chrome' },
        { pid: 400, name: 'callservicesd', is_running_output: false, is_user_app: false },
      ],
    }) + '\n';
    const fakeRunner = vi.fn(async () => ({ stdout: helperOutput, stderr: '' }));
    const e = new AppEnumerator({ helperPath: '/h', runner: fakeRunner });

    const sources = await e.list();
    const chrome = sources.filter((s) => s.ownerPid === 300);
    expect(chrome).toHaveLength(1);
    expect(chrome[0]!.pid).toBe(302); // the audible helper is the tap target
    expect(chrome[0]!.name).toBe('Google Chrome'); // displayed as the owning app
    expect(chrome[0]!.isRunningOutput).toBe(true);
    // Daemons pass through unmerged and flagged for the picker to tuck away.
    expect(sources.find((s) => s.pid === 400)!.isUserApp).toBe(false);
  });

  it('inherits the meeting badge from any sibling of the same owner', async () => {
    const helperOutput = JSON.stringify({
      event: 'processes',
      items: [
        { pid: 501, name: 'zoom helper', is_meeting_app: true, is_running_output: false, is_user_app: true, owner_pid: 500, owner_name: 'zoom.us' },
        { pid: 502, name: 'zoom render', is_meeting_app: false, is_running_output: true, is_user_app: true, owner_pid: 500, owner_name: 'zoom.us' },
      ],
    }) + '\n';
    const fakeRunner = vi.fn(async () => ({ stdout: helperOutput, stderr: '' }));
    const e = new AppEnumerator({ helperPath: '/h', runner: fakeRunner });

    const sources = await e.list();
    expect(sources).toHaveLength(1);
    expect(sources[0]!.isMeetingApp).toBe(true);
    expect(sources[0]!.isRunningOutput).toBe(true);
  });

  it('treats named sources from older helpers (no is_user_app) as user apps', async () => {
    const helperOutput = JSON.stringify({
      event: 'processes',
      items: [
        { pid: 100, name: 'Music', is_running_output: true },
        { pid: 101, is_running_output: false },
      ],
    }) + '\n';
    const fakeRunner = vi.fn(async () => ({ stdout: helperOutput, stderr: '' }));
    const e = new AppEnumerator({ helperPath: '/h', runner: fakeRunner });

    const sources = await e.list();
    expect(sources.find((s) => s.pid === 100)!.isUserApp).toBe(true);
    expect(sources.find((s) => s.pid === 101)!.isUserApp).toBe(false);
  });
});
