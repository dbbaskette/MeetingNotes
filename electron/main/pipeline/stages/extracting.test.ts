import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runExtracting } from './extracting.js';

describe('runExtracting', () => {
  it('calls LLM, parses JSON, writes action-items.json + repo', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-e-'));
    const f = path.join(dir, 'meetings', 'slug');
    fs.mkdirSync(f, { recursive: true });
    fs.writeFileSync(path.join(f, 'transcript.md'), '...');

    const chat = vi.fn(
      async () => '[{"text":"Send update","owner":"Dan","due_date":"2026-04-22"}]',
    );
    const replace = vi.fn();
    const ctx: any = {
      libraryRoot: dir,
      lmStudio: { chat },
      meetings: { findById: () => ({ slug: 'slug' }) },
      actionItems: { replaceForMeeting: replace },
      settings: { get: () => 'llama-3.1-8b' },
      logger: { info: () => {} },
    };
    await runExtracting({ meetingId: 'm' }, ctx);
    expect(replace).toHaveBeenCalledWith(
      'm',
      expect.arrayContaining([expect.objectContaining({ text: 'Send update' })]),
    );
    const written = JSON.parse(fs.readFileSync(path.join(f, 'action-items.json'), 'utf8'));
    expect(written).toHaveLength(1);
  });
});
