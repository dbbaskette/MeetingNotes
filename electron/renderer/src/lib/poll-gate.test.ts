import { describe, it, expect } from 'vitest';
import { shouldPollLibrary } from './poll-gate';

const idle = { currentId: null, queueLength: 0 };

describe('shouldPollLibrary', () => {
  it('does NOT poll when the pipeline is idle, even with pending meetings present', () => {
    // The regression: a lone pending recording used to keep the 3s poll
    // running forever. Pending is static — it only changes via a user
    // action or a push event, never on its own — so an idle pipeline
    // (what the status bar shows as "Ready") must not poll.
    expect(shouldPollLibrary(idle, false)).toBe(false);
  });

  it('polls while a meeting is actively processing (currentId set)', () => {
    expect(shouldPollLibrary({ currentId: 'm1', queueLength: 0 }, false)).toBe(true);
  });

  it('polls while items are queued but none current yet', () => {
    expect(shouldPollLibrary({ currentId: null, queueLength: 3 }, false)).toBe(true);
  });

  it('polls while a live recording is in progress', () => {
    expect(shouldPollLibrary(idle, true)).toBe(true);
  });

  it('polls when both current and queued', () => {
    expect(shouldPollLibrary({ currentId: 'm1', queueLength: 2 }, false)).toBe(true);
  });
});
