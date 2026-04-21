import { describe, it, expect, vi } from 'vitest';
import { MeetingDetector } from './detector.js';
import { matchMeeting } from './patterns.js';

describe('matchMeeting', () => {
  it('matches well-known meeting URLs', () => {
    expect(matchMeeting('https://meet.google.com/abc-defg-hij')).toBe('Google Meet');
    expect(matchMeeting('https://zoom.us/j/1234567890')).toBe('Zoom');
    expect(matchMeeting('https://us02web.zoom.us/j/1234567890')).toBe('Zoom');
    expect(matchMeeting('https://teams.microsoft.com/l/meetup-join/foo')).toBe('Microsoft Teams');
    expect(matchMeeting('https://whereby.com/my-room')).toBe('Whereby');
    expect(matchMeeting('https://meet.jit.si/MyRoom')).toBe('Jitsi Meet');
  });
  it('returns null for non-meeting URLs', () => {
    expect(matchMeeting('https://github.com/foo/bar')).toBeNull();
    expect(matchMeeting('https://news.ycombinator.com')).toBeNull();
    expect(matchMeeting('https://zoom.us/pricing')).toBeNull();
  });
});

describe('MeetingDetector', () => {
  it('emits on first meeting URL and suppresses repeat ticks for the same URL', async () => {
    const listener = vi.fn();
    const d = new MeetingDetector({
      queryBrowsers: async () => [
        { browser: 'chrome', url: 'https://meet.google.com/xyz-abcd-efg', title: 'Meet', pid: 1234 },
      ],
    });
    d.onDetected(listener);
    await d.tick();
    await d.tick();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0]).toMatchObject({
      platform: 'Google Meet',
      url: 'https://meet.google.com/xyz-abcd-efg',
      browserPid: 1234,
      browserLabel: 'Google Chrome',
    });
  });

  it('re-emits after the user leaves the meeting URL and returns', async () => {
    const listener = vi.fn();
    let tabs = [
      { browser: 'chrome' as const, url: 'https://meet.google.com/xyz-abcd-efg', title: 'Meet', pid: 1234 },
    ];
    const d = new MeetingDetector({ queryBrowsers: async () => tabs });
    d.onDetected(listener);
    await d.tick(); // first emit
    tabs = [{ browser: 'chrome', url: 'https://github.com', title: 'GH', pid: 1234 }];
    await d.tick(); // clears latch
    tabs = [{ browser: 'chrome', url: 'https://meet.google.com/xyz-abcd-efg', title: 'Meet', pid: 1234 }];
    await d.tick(); // re-emit
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('respects dismiss() per URL', async () => {
    const listener = vi.fn();
    const d = new MeetingDetector({
      queryBrowsers: async () => [
        { browser: 'chrome', url: 'https://meet.google.com/xyz', title: 't', pid: 1 },
      ],
    });
    d.onDetected(listener);
    d.dismiss('https://meet.google.com/xyz');
    await d.tick();
    expect(listener).not.toHaveBeenCalled();
  });

  it('respects isSuppressed (e.g. recording already active)', async () => {
    const listener = vi.fn();
    const d = new MeetingDetector({
      isSuppressed: () => true,
      queryBrowsers: async () => [
        { browser: 'chrome', url: 'https://meet.google.com/xyz', title: 't', pid: 1 },
      ],
    });
    d.onDetected(listener);
    await d.tick();
    expect(listener).not.toHaveBeenCalled();
  });

  it('swallows queryBrowsers errors (AppleScript hiccups, etc.)', async () => {
    const listener = vi.fn();
    const d = new MeetingDetector({
      queryBrowsers: async () => { throw new Error('automation perms denied'); },
    });
    d.onDetected(listener);
    await expect(d.tick()).resolves.toBeUndefined();
    expect(listener).not.toHaveBeenCalled();
  });
});
