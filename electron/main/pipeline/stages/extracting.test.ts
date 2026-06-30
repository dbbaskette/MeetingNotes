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
      llmSupervisor: { ensureReady: async () => {} },
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

  it('sends generous token headroom and a preamble-forbidding system prompt', () => {
    // Reasoning models (e.g. Gemma 4) ignore enable_thinking and stall on the
    // extract task — restating the transcript until the budget runs out. Guard
    // the two levers that keep them on track: enough budget to reach the JSON,
    // and a system prompt that forbids the reasoning preamble.
    const chat = vi.fn(async () => '[]');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-e-'));
    const f = path.join(dir, 'meetings', 'slug');
    fs.mkdirSync(f, { recursive: true });
    fs.writeFileSync(path.join(f, 'transcript.md'), '...');
    const ctx: any = {
      libraryRoot: dir,
      llmSupervisor: { ensureReady: async () => {} },
      lmStudio: { chat },
      meetings: { findById: () => ({ slug: 'slug' }) },
      actionItems: { replaceForMeeting: () => {} },
      settings: { get: () => 'llama-3.1-8b' },
      logger: { info: () => {} },
    };
    return runExtracting({ meetingId: 'm' }, ctx).then(() => {
      const arg = chat.mock.calls[0]![0] as { maxTokens: number; messages: { content: string }[] };
      expect(arg.maxTokens).toBe(8000);
      expect(arg.messages[0]!.content).toContain('Do NOT think out loud');
    });
  });
});
