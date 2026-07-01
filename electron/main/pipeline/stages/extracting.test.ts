import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runExtracting } from './extracting.js';

function makeCtx(chat: (input: unknown) => Promise<string>): { ctx: any; folder: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-e-'));
  const folder = path.join(dir, 'meetings', 'slug');
  fs.mkdirSync(folder, { recursive: true });
  const ctx: any = {
    libraryRoot: dir,
    llmSupervisor: { ensureReady: async () => {} },
    lmStudio: { chat: vi.fn(chat) },
    meetings: { findById: () => ({ slug: 'slug' }) },
    actionItems: { replaceForMeeting: vi.fn() },
    settings: { get: () => 'llama-3.1-8b' },
    logger: { info: () => {} },
  };
  return { ctx, folder };
}

const SUMMARY = '## Overview\nWeekly sync.\n\n## Action Items\n- Send update — Dan — 2026-04-22';

describe('runExtracting', () => {
  it('sends summary.md to the LLM, parses JSON, writes action-items.json + repo', async () => {
    const { ctx, folder } = makeCtx(
      async () => '[{"text":"Send update","owner":"Dan","due_date":"2026-04-22"}]',
    );
    fs.writeFileSync(path.join(folder, 'summary.md'), SUMMARY);
    await runExtracting({ meetingId: 'm' }, ctx);
    // The user message is the summary, not a transcript.
    const arg = ctx.lmStudio.chat.mock.calls[0]![0] as { messages: { content: string }[] };
    expect(arg.messages[1]!.content).toBe(SUMMARY);
    expect(ctx.actionItems.replaceForMeeting).toHaveBeenCalledWith(
      'm',
      expect.arrayContaining([expect.objectContaining({ text: 'Send update' })]),
    );
    const written = JSON.parse(fs.readFileSync(path.join(folder, 'action-items.json'), 'utf8'));
    expect(written).toHaveLength(1);
  });

  it('fails with an actionable error when summary.md is missing or empty', async () => {
    // No-fallback by design: extract must never silently fall back to the
    // transcript (the input that made small reasoning models loop). A missing
    // summary means the pipeline state is broken — say so and stop.
    const missing = makeCtx(async () => '[]');
    await expect(runExtracting({ meetingId: 'm' }, missing.ctx)).rejects.toThrow(
      /summary\.md is missing or empty/,
    );
    const empty = makeCtx(async () => '[]');
    fs.writeFileSync(path.join(empty.folder, 'summary.md'), '  \n');
    await expect(runExtracting({ meetingId: 'm' }, empty.ctx)).rejects.toThrow(
      /summary\.md is missing or empty/,
    );
    expect(missing.ctx.lmStudio.chat).not.toHaveBeenCalled();
    expect(empty.ctx.lmStudio.chat).not.toHaveBeenCalled();
  });

  it('caps the budget at 2000 tokens and keeps the preamble-forbidding prompt', async () => {
    // The summary input is 1–3k tokens, so 2000 output tokens is generous for
    // the short JSON answer while bounding a still-looping reasoning model to
    // tens of seconds instead of minutes.
    const { ctx, folder } = makeCtx(async () => '[]');
    fs.writeFileSync(path.join(folder, 'summary.md'), SUMMARY);
    await runExtracting({ meetingId: 'm' }, ctx);
    const arg = ctx.lmStudio.chat.mock.calls[0]![0] as {
      maxTokens: number;
      messages: { content: string }[];
    };
    expect(arg.maxTokens).toBe(2000);
    expect(arg.messages[0]!.content).toContain('Do NOT think out loud');
  });
});
