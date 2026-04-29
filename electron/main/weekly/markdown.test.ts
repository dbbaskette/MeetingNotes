import { describe, it, expect } from 'vitest';
import { renderWeeklyMarkdown } from './markdown.js';
import type { WeeklyData } from './aggregator.js';

function baseData(over: Partial<WeeklyData> = {}): WeeklyData {
  return {
    isoYear: 2026,
    isoWeek: 17,
    rangeStart: '2026-04-20T00:00:00.000Z',
    rangeEnd: '2026-04-26T23:59:59.999Z',
    totalDurationS: 0,
    meetings: [],
    openActionGroups: [],
    openActionCount: 0,
    narrative: '',
    decisions: [],
    generatedAt: '',
    inProgress: false,
    ...over,
  };
}

describe('renderWeeklyMarkdown', () => {
  it('renders a header with the date range', () => {
    const md = renderWeeklyMarkdown(baseData());
    expect(md).toMatch(/^# Weekly summary — Apr 20 – Apr 26, 2026/m);
  });

  it('shows empty-state line when there are no meetings', () => {
    const md = renderWeeklyMarkdown(baseData());
    expect(md).toContain('*No meetings captured this week.*');
  });

  it('renders meetings as a table with day + duration', () => {
    const md = renderWeeklyMarkdown(baseData({
      meetings: [
        { id: 'm1', title: 'Q2 planning', startedAt: '2026-04-20T10:00:00Z', durationS: 2700, highlight: null, speakerCount: 3 },
        { id: 'm2', title: 'Vendor sync — Acme', startedAt: '2026-04-22T15:00:00Z', durationS: 1800, highlight: null, speakerCount: 2 },
      ],
    }));
    expect(md).toContain('## Meetings');
    expect(md).toContain('| Day | Meeting');
    expect(md).toContain('| Q2 planning |');
    expect(md).toContain('45m');
    // Pipe in title is escaped so the table doesn't break.
    const md2 = renderWeeklyMarkdown(baseData({
      meetings: [{ id: 'm', title: 'A | B', startedAt: '2026-04-20T10:00:00Z', durationS: 60, highlight: null, speakerCount: null }],
    }));
    expect(md2).toContain('A \\| B');
  });

  it('groups action items by owner with checkboxes', () => {
    const md = renderWeeklyMarkdown(baseData({
      openActionCount: 2,
      openActionGroups: [
        {
          ownerLabel: 'You', isYou: true, items: [
            { id: 'a', meetingId: 'm', meetingTitle: 'X', text: 'Send SOC2 doc', ownerLabel: 'You', isYou: true, status: 'open', dueDate: '2026-04-25', meetingStartedAt: '2026-04-22T10:00:00Z' },
          ],
        },
        {
          ownerLabel: 'Alex', isYou: false, items: [
            { id: 'b', meetingId: 'm', meetingTitle: 'Y', text: 'Pilot SLA', ownerLabel: 'Alex', isYou: false, status: 'open', dueDate: null, meetingStartedAt: '2026-04-23T10:00:00Z' },
          ],
        },
      ],
    }));
    expect(md).toContain('**You (1)**');
    expect(md).toContain('- [ ] Send SOC2 doc — *due 2026-04-25*');
    expect(md).toContain('**Alex (1)**');
    expect(md).toContain('- [ ] Pilot SLA');
  });

  it('renders the narrative + decisions sections when present', () => {
    const md = renderWeeklyMarkdown(baseData({
      narrative: 'This week was about Q2.',
      decisions: ['Locked OKRs — Q2 planning', 'Acme moves to monthly billing — Vendor sync'],
      meetings: [{ id: 'm', title: 'Q2 planning', startedAt: '2026-04-20T10:00:00Z', durationS: 60, highlight: null, speakerCount: null }],
    }));
    expect(md).toContain('## Overview');
    expect(md).toContain('This week was about Q2.');
    expect(md).toContain('## Key decisions');
    expect(md).toContain('- Locked OKRs — Q2 planning');
  });
});
