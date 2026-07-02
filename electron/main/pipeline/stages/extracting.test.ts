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

  it('attaches source_quote by matching items to the summary bullets', async () => {
    const summary =
      '## Action Items\n' +
      '- Ship the v2 API by Friday — Dan — 2026-07-03\n' +
      '- Buy more coffee — (owner TBD) — (no date)';
    const { ctx, folder } = makeCtx(
      // Model returns a reworded item plus one that matches nothing in the summary.
      async () =>
        '[{"text":"Ship v2 API","owner":"Dan","due_date":"2026-07-03"},' +
        '{"text":"Rewrite the auth service from scratch","owner":null,"due_date":null}]',
    );
    fs.writeFileSync(path.join(folder, 'summary.md'), summary);
    await runExtracting({ meetingId: 'm' }, ctx);

    const persisted = ctx.actionItems.replaceForMeeting.mock.calls[0]![1] as {
      text: string; sourceQuote: string | null;
    }[];
    expect(persisted[0]!.sourceQuote).toBe('Ship the v2 API by Friday — Dan — 2026-07-03');
    expect(persisted[1]!.sourceQuote).toBeNull();

    // action-items.json carries the same enriched shape.
    const written = JSON.parse(fs.readFileSync(path.join(folder, 'action-items.json'), 'utf8'));
    expect(written[0].sourceQuote).toContain('v2 API');
  });

  it('gives reasoning room (4000 tokens), re-samples spirals, and forbids preamble', async () => {
    // Gemma reasons ~2000 words before emitting the JSON; the old 2000 cap
    // guillotined it mid-thought → empty content. 4000 leaves room, and
    // resampleRetries re-samples the intermittent spiral (temperature 0 makes a
    // plain retry deterministic, so the client bumps the retry temperature).
    const { ctx, folder } = makeCtx(async () => '[]');
    fs.writeFileSync(path.join(folder, 'summary.md'), SUMMARY);
    await runExtracting({ meetingId: 'm' }, ctx);
    const arg = ctx.lmStudio.chat.mock.calls[0]![0] as {
      maxTokens: number;
      resampleRetries: number;
      messages: { content: string }[];
    };
    expect(arg.maxTokens).toBe(4000);
    expect(arg.resampleRetries).toBe(2);
    expect(arg.messages[0]!.content).toContain('Do NOT think out loud');
  });
});
