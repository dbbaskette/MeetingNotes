import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runSummarizing, extractTitleFromSummary } from './summarizing.js';

describe('runSummarizing', () => {
  it('reads transcript.md, calls LLM, writes summary.md', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-s-'));
    const f = path.join(dir, 'meetings', 'slug');
    fs.mkdirSync(f, { recursive: true });
    fs.writeFileSync(path.join(f, 'transcript.md'), '[SPEAKER_00 00:00] Hi.');

    const chat = vi.fn(async () => '## Overview\nshort meeting.');
    const ctx: any = {
      libraryRoot: dir,
      llmSupervisor: { ensureReady: async () => {} },
      lmStudio: { chat },
      meetings: { findById: () => ({ slug: 'slug', title: 'Team sync' }), updateTitle: vi.fn() },
      settings: { get: (k: string) => (k === 'llmModel' ? 'llama-3.1-8b' : '') },
      logger: { info: () => {} },
    };
    await runSummarizing({ meetingId: 'm' }, ctx);
    expect(fs.readFileSync(path.join(f, 'summary.md'), 'utf8')).toContain('Overview');
    expect(chat).toHaveBeenCalled();
    // User already renamed this meeting ("Team sync"); summariser must not
    // overwrite their title.
    expect(ctx.meetings.updateTitle).not.toHaveBeenCalled();
  });

  it('auto-titles meetings whose title is still the default recording-... filename', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-s-auto-'));
    const f = path.join(dir, 'meetings', 'slug');
    fs.mkdirSync(f, { recursive: true });
    fs.writeFileSync(path.join(f, 'transcript.md'), '[SPEAKER_00 00:00] Hi.');

    const chat = vi.fn(async () => '## Overview\nQuarterly engineering review covering the migration plan and rollout timing.\n\n## Decisions\n- Ship Tuesday.');
    const updateTitle = vi.fn();
    const ctx: any = {
      libraryRoot: dir,
      llmSupervisor: { ensureReady: async () => {} },
      lmStudio: { chat },
      meetings: {
        findById: () => ({ slug: 'slug', title: 'recording-20260421-163203-47c0c0f5' }),
        updateTitle,
      },
      settings: { get: () => 'llama-3.1-8b' },
      logger: { info: () => {} },
    };
    await runSummarizing({ meetingId: 'm' }, ctx);
    expect(updateTitle).toHaveBeenCalledOnce();
    const newTitle = updateTitle.mock.calls[0][1] as string;
    expect(newTitle).toContain('Quarterly engineering review');
  });
});

describe('extractTitleFromSummary', () => {
  it('pulls the first sentence of Overview', () => {
    const title = extractTitleFromSummary('## Overview\nPlanning the next sprint. We talked about scope.\n\n## Decisions\n- Ship it');
    expect(title).toBe('Planning the next sprint');
  });
  it('strips leading bullets', () => {
    const title = extractTitleFromSummary('## Overview\n- **Security review:** covering auth + IAM work.\n');
    expect(title).toBe('Security review — covering auth + IAM work');
  });
  it('truncates long lines with ellipsis', () => {
    const long = 'A very long discussion that goes on and on without any period for a long time and keeps going';
    const title = extractTitleFromSummary(`## Overview\n${long}\n`);
    expect(title!.length).toBeLessThanOrEqual(70);
    expect(title!).toMatch(/…$/);
  });
  it('returns null when Overview is empty or too short', () => {
    expect(extractTitleFromSummary('## Overview\n\n## Decisions\n- foo')).toBeNull();
    expect(extractTitleFromSummary('## Overview\nhi.')).toBeNull();
  });
  it('returns null when there is no Overview heading', () => {
    expect(extractTitleFromSummary('# Notes\nblah blah blah')).toBeNull();
  });
});
