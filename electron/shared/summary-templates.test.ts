import { describe, expect, it } from 'vitest';
import { allSummaryHeadings, demoteSummaryHeadings, SUMMARY_TEMPLATES, templateSections } from './summary-templates.js';

describe('demoteSummaryHeadings', () => {
  it('demotes an H1 for every section of every template', () => {
    for (const template of SUMMARY_TEMPLATES) {
      for (const section of templateSections(template)) {
        expect(demoteSummaryHeadings(`# ${section}\ntext`), `${template.id}: ${section}`).toBe(`## ${section}\ntext`);
      }
    }
  });
  it('covers the sections the old hand-written list missed', () => {
    const notes = '# Overview\nx\n# Updates\ny\n# Blockers and Support Needed\nz\n# Topics for Next Time\nw\n# Next Steps\nv';
    expect(demoteSummaryHeadings(notes)).toBe('## Overview\nx\n## Updates\ny\n## Blockers and Support Needed\nz\n## Topics for Next Time\nw\n## Next Steps\nv');
  });
  it('leaves other H1s, existing H2s and body text alone', () => {
    const notes = '# Meeting with Ana\n## Decisions\n- Decisions were made\nA line with # Overview inside';
    expect(demoteSummaryHeadings(notes)).toBe(notes);
  });
  it('keeps a trailing colon or qualifier on the heading', () => {
    expect(demoteSummaryHeadings('# Decisions:')).toBe('## Decisions:');
  });
  it('lists each heading once', () => {
    const headings = allSummaryHeadings();
    expect(new Set(headings).size).toBe(headings.length);
    expect(headings).toContain('Blockers');
    expect(headings).toContain('Blockers and Support Needed');
  });
});
