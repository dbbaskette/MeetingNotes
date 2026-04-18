import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MarkdownExporter } from './markdown.js';

const dirs: string[] = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

describe('MarkdownExporter', () => {
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
    expect(md).toContain('# Q2 — Action Items');
    expect(md).toContain('- [ ] do A — Dan — due 2026-04-22');
    expect(md).toContain('- [x] do B');
  });
});
