import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MarkdownExporter, buildMeetingMarkdown } from './markdown.js';

const dirs: string[] = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

describe('MarkdownExporter', () => {
  it('uses selected rows as the only action-item list', () => {
    const md = buildMeetingMarkdown({
      items: [{ id: 'selected', text: 'Selected task', ownerName: null, dueDate: null, status: 'open' }],
      meetingTitle: 'Review', meetingFolder: '/unused',
      summaryMd: '## Overview\nKeep this.\n\n## Action Items\n- Stale generated task\n\n## Decisions\nShip it.',
    });
    expect(md.match(/## Action Items/g)).toHaveLength(1);
    expect(md).not.toContain('Stale generated task');
    expect(md).toContain('Selected task');
    expect(md).toContain('## Decisions');
  });

  it('exports notes alone without an empty action-item section', () => {
    const md = buildMeetingMarkdown({
      items: [], meetingTitle: 'Review', meetingFolder: '/unused',
      summaryMd: '## Overview\nKeep this.\n\n## Action Items\n- Stale generated task',
    });
    expect(md).toContain('Keep this.');
    expect(md).not.toContain('Action Items');
    expect(md).not.toContain('Stale generated task');
  });
  it('writes a markdown file with items as a checklist', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-md-')); dirs.push(dir);
    const exp = new MarkdownExporter();
    const outPath = await exp.export({
      items: [
        { id: '1', text: 'do A', ownerName: 'Dan', dueDate: '2026-04-22', status: 'open' },
        { id: '2', text: 'do B', ownerName: null, dueDate: null, status: 'done' },
      ],
      meetingTitle: 'Q2',
      meetingFolder: dir,
    });
    const md = fs.readFileSync(outPath, 'utf8');
    expect(md).toContain('# Q2');
    expect(md).toContain('## Action Items');
    expect(md).toContain('- [ ] do A — Dan — due 2026-04-22');
    expect(md).toContain('- [x] do B');
  });

  it('includes the summary before the action items when provided', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-md-')); dirs.push(dir);
    const exp = new MarkdownExporter();
    const outPath = await exp.export({
      items: [{ id: '1', text: 'do A', ownerName: null, dueDate: null, status: 'open' }],
      meetingTitle: 'Q2',
      meetingFolder: dir,
      summaryMd: '## Overview\n\nDiscussed roadmap.',
    });
    const md = fs.readFileSync(outPath, 'utf8');
    expect(md.indexOf('## Overview')).toBeLessThan(md.indexOf('## Action Items'));
    expect(md).toContain('Discussed roadmap.');
  });
});
