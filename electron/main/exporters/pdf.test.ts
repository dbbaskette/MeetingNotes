import { describe, expect, it } from 'vitest';
import { notesWithoutActionItems, renderMeetingPdfHtml } from './pdf.js';

const base = {
  meetingTitle: 'Design sync',
  meetingFolder: '/tmp/meeting',
  summaryMd: '## Overview\n\nWe agreed on the layout.\n\n## Action Items\n\n- Old task\n\n## Decisions\n\nUse the new layout.',
};

describe('PDF meeting export', () => {
  it('omits the summary action section when exporting notes only', () => {
    const html = renderMeetingPdfHtml({ ...base, items: [] });
    expect(html).toContain('We agreed on the layout.');
    expect(html).toContain('Use the new layout.');
    expect(html).not.toContain('Old task');
    expect(html).not.toContain('<section class="actions">');
  });

  it('includes only selected action items and escapes user content', () => {
    const html = renderMeetingPdfHtml({
      ...base,
      meetingTitle: '<Design sync>',
      summaryMd: `${base.summaryMd}\n\n<script>alert('x')</script>`,
      items: [{ id: 'a', text: 'Ship <safe> PDF', ownerName: 'Dan & team', dueDate: '2026-09-25', status: 'open' }],
    });
    expect(html).toContain('&lt;Design sync&gt;');
    expect(html).toContain('Ship &lt;safe&gt; PDF');
    expect(html).toContain('Dan &amp; team · Due 2026-09-25');
    expect(html).not.toContain('Old task');
    expect(html).not.toContain('<script>alert');
  });

  it('retains headings following the Action Items section', () => {
    expect(notesWithoutActionItems('## Action Items\n- Task\n### Subheading\nMore\n## Decisions\nKeep this'))
      .toBe('## Decisions\nKeep this');
  });
});
