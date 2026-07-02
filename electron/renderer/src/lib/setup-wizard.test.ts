import { describe, it, expect } from 'vitest';
import { firstRunStatus, canAdvance, statusFromProbe } from './setup-wizard';

describe('firstRunStatus', () => {
  it("returns 'needed' when the app has never been onboarded", () => {
    expect(firstRunStatus(null)).toBe('needed');
  });

  it("returns 'done' once onboardedAt is stamped", () => {
    expect(firstRunStatus('2026-07-01T00:00:00.000Z')).toBe('done');
  });

  it("forceOpen re-opens the wizard without clearing the onboarded fact", () => {
    // Re-run from Settings: show the wizard even though the user has
    // onboarded before, and do NOT depend on wiping onboardedAt.
    expect(firstRunStatus('2026-07-01T00:00:00.000Z', { forceOpen: true })).toBe('needed');
    expect(firstRunStatus(null, { forceOpen: true })).toBe('needed');
  });
});

describe('canAdvance', () => {
  it('blocks only while a check is in flight', () => {
    expect(canAdvance('checking')).toBe(false);
  });

  it('lets the user proceed from pending, ok, and warn', () => {
    // 'warn' is deliberately advanceable — a user who knowingly keeps a
    // reasoning model or an unreachable STT server must never be trapped.
    expect(canAdvance('pending')).toBe(true);
    expect(canAdvance('ok')).toBe(true);
    expect(canAdvance('warn')).toBe(true);
  });
});

describe('statusFromProbe', () => {
  it("maps a null outcome to 'pending'", () => {
    expect(statusFromProbe(null)).toBe('pending');
  });

  it('maps an ok probe to ok and a failed probe to warn', () => {
    expect(statusFromProbe({ ok: true })).toBe('ok');
    expect(statusFromProbe({ ok: false })).toBe('warn');
  });

  it("maps a health-check verdict: 'ok' -> ok, 'loops' -> warn", () => {
    expect(statusFromProbe({ verdict: 'ok' })).toBe('ok');
    expect(statusFromProbe({ verdict: 'loops' })).toBe('warn');
  });
});
