import { describe, it, expect, vi } from 'vitest';
import { AppEnumerator } from './app-enumerator.js';

describe('AppEnumerator', () => {
  it('parses helper output into source list', async () => {
    const helperOutput = JSON.stringify({
      event: 'processes',
      items: [
        { pid: 100, bundle_id: 'us.zoom.xos', name: 'Zoom', is_meeting_app: true },
        { pid: 200, bundle_id: 'com.google.Chrome', name: 'Google Chrome', is_meeting_app: false },
      ],
    }) + '\n';
    const fakeRunner = vi.fn(async () => ({ stdout: helperOutput, stderr: '' }));
    const e = new AppEnumerator({ helperPath: '/bin/meeting-notes-tap', runner: fakeRunner });

    const sources = await e.list();
    expect(sources).toHaveLength(2);
    expect(sources[0]!.isMeetingApp).toBe(true);
    expect(sources[0]!.name).toBe('Zoom');
  });

  it('returns empty list when helper emits no processes line', async () => {
    const fakeRunner = vi.fn(async () => ({ stdout: '\n', stderr: '' }));
    const e = new AppEnumerator({ helperPath: '/h', runner: fakeRunner });
    expect(await e.list()).toEqual([]);
  });
});
