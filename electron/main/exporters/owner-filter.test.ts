import { describe, it, expect } from 'vitest';
import { isMyItem, userIsIdentified, TASK_APP_EXPORTERS } from './owner-filter.js';

const me = { userSpeakerId: 'spk-me', userDisplayName: 'Dan Baskette' };

describe('isMyItem', () => {
  it('matches by roster speaker id', () => {
    expect(isMyItem({ ownerSpeakerId: 'spk-me', ownerName: null }, me)).toBe(true);
    expect(isMyItem({ ownerSpeakerId: 'spk-other', ownerName: null }, me)).toBe(false);
  });

  it('matches a free-text owner name case/space-insensitively', () => {
    expect(isMyItem({ ownerSpeakerId: null, ownerName: '  dan baskette ' }, me)).toBe(true);
    expect(isMyItem({ ownerSpeakerId: null, ownerName: 'Dan' }, me)).toBe(false);
  });

  it('is false for unowned items', () => {
    expect(isMyItem({ ownerSpeakerId: null, ownerName: null }, me)).toBe(false);
  });

  it('is false when the user has not identified themselves', () => {
    const anon = { userSpeakerId: null, userDisplayName: null };
    expect(isMyItem({ ownerSpeakerId: 'spk-me', ownerName: 'Dan Baskette' }, anon)).toBe(false);
  });

  it('roster id wins even when names differ', () => {
    expect(isMyItem({ ownerSpeakerId: 'spk-me', ownerName: 'Someone Else' }, me)).toBe(true);
  });
});

describe('userIsIdentified', () => {
  it('is true only when a userSpeakerId is set', () => {
    expect(userIsIdentified(me)).toBe(true);
    expect(userIsIdentified({ userSpeakerId: null, userDisplayName: 'Dan' })).toBe(false);
  });
});

describe('TASK_APP_EXPORTERS', () => {
  it('covers the task-manager exporters but not the document ones', () => {
    expect(TASK_APP_EXPORTERS.has('reminders')).toBe(true);
    expect(TASK_APP_EXPORTERS.has('google-tasks')).toBe(true);
    expect(TASK_APP_EXPORTERS.has('markdown')).toBe(false);
    expect(TASK_APP_EXPORTERS.has('google-doc')).toBe(false);
  });
});
