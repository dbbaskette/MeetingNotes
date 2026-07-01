import { describe, it, expect } from 'vitest';
import { matchSourceQuotes } from './action-item-source.js';
import type { ActionItem } from './action-item-schema.js';

const item = (text: string): ActionItem => ({ text, owner: null, due_date: null });

const SUMMARY = `## Overview
Weekly sync.

## Action Items
- Ship the v2 API by Friday — Dan — 2026-07-03
- Write the migration guide — Priya — (no date)

## Follow-ups
- Nothing pending.`;

describe('matchSourceQuotes', () => {
  it('matches a reworded item to its verbatim summary bullet', () => {
    const [r] = matchSourceQuotes([item('Ship v2 API')], SUMMARY);
    expect(r!.sourceQuote).toBe('Ship the v2 API by Friday — Dan — 2026-07-03');
  });

  it('matches each item to its own bullet', () => {
    const res = matchSourceQuotes(
      [item('Write migration guide'), item('Ship the v2 API')],
      SUMMARY,
    );
    expect(res[0]!.sourceQuote).toContain('migration guide');
    expect(res[1]!.sourceQuote).toContain('v2 API');
  });

  it('returns null when nothing clears the threshold', () => {
    const [r] = matchSourceQuotes([item('Book the offsite venue in Lisbon')], SUMMARY);
    expect(r!.sourceQuote).toBeNull();
  });

  it('falls back to all bullets when there is no Action Items section', () => {
    const noSection = `## Overview\nStuff.\n\n## Decisions\n- Adopt Postgres for the new service.`;
    const [r] = matchSourceQuotes([item('Adopt Postgres for the service')], noSection);
    expect(r!.sourceQuote).toBe('Adopt Postgres for the new service.');
  });

  it('returns null for every item on an empty summary', () => {
    const res = matchSourceQuotes([item('anything'), item('else')], '');
    expect(res.every((r) => r.sourceQuote === null)).toBe(true);
  });

  it('preserves the original item fields', () => {
    const [r] = matchSourceQuotes(
      [{ text: 'Ship v2 API', owner: 'Dan', due_date: '2026-07-03' }],
      SUMMARY,
    );
    expect(r!.owner).toBe('Dan');
    expect(r!.due_date).toBe('2026-07-03');
  });
});
