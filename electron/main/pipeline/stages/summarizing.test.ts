import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runSummarizing } from './summarizing.js';

describe('runSummarizing', () => {
  it('reads transcript.md, calls LLM, writes summary.md', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-s-'));
    const f = path.join(dir, 'meetings', 'slug');
    fs.mkdirSync(f, { recursive: true });
    fs.writeFileSync(path.join(f, 'transcript.md'), '[SPEAKER_00 00:00] Hi.');

    const chat = vi.fn(async () => '## Overview\nshort meeting.');
    const ctx: any = {
      libraryRoot: dir,
      lmStudio: { chat },
      meetings: { findById: () => ({ slug: 'slug' }) },
      settings: { get: (k: string) => (k === 'llmModel' ? 'llama-3.1-8b' : '') },
      logger: { info: () => {} },
    };
    await runSummarizing({ meetingId: 'm' }, ctx);
    expect(fs.readFileSync(path.join(f, 'summary.md'), 'utf8')).toContain('Overview');
    expect(chat).toHaveBeenCalled();
  });
});
