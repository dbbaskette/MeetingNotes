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

  it('passes the meeting title to the prompt as the known topic', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-s-topic-'));
    const f = path.join(dir, 'meetings', 'slug');
    fs.mkdirSync(f, { recursive: true });
    fs.writeFileSync(path.join(f, 'transcript.md'), '[SPEAKER_00 00:00] Hi.');

    const chat = vi.fn(async () => '## Overview\nshort meeting.');
    const ctx: any = {
      libraryRoot: dir,
      llmSupervisor: { ensureReady: async () => {} },
      lmStudio: { chat },
      meetings: { findById: () => ({ slug: 'slug', title: 'Team sync' }), updateTitle: vi.fn() },
      settings: { get: (k: string) => (k === 'llmModel' ? 'llama-3.1-8b' : 'detailed') },
      logger: { info: () => {} },
    };
    await runSummarizing({ meetingId: 'm' }, ctx);
    const systemMsg = chat.mock.calls[0][0].messages[0].content as string;
    expect(systemMsg).toContain('This meeting is about: **Team sync**');
  });

  it('omits the topic anchor for default recording-... titles', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-s-noanchor-'));
    const f = path.join(dir, 'meetings', 'slug');
    fs.mkdirSync(f, { recursive: true });
    fs.writeFileSync(path.join(f, 'transcript.md'), '[SPEAKER_00 00:00] Hi.');

    const chat = vi.fn(async () => '## Overview\nshort meeting.');
    const ctx: any = {
      libraryRoot: dir,
      llmSupervisor: { ensureReady: async () => {} },
      lmStudio: { chat },
      meetings: {
        findById: () => ({ slug: 'slug', title: 'recording-20260421-163203-47c0c0f5' }),
        updateTitle: vi.fn(),
      },
      settings: { get: (k: string) => (k === 'llmModel' ? 'llama-3.1-8b' : 'detailed') },
      logger: { info: () => {} },
    };
    await runSummarizing({ meetingId: 'm' }, ctx);
    const systemMsg = chat.mock.calls[0][0].messages[0].content as string;
    expect(systemMsg).toContain("Infer the meeting's main purpose");
    expect(systemMsg).not.toContain('This meeting is about:');
  });

  it('demotes a stray "# Off-topic Conversation" H1 to H2', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-s-h1-'));
    const f = path.join(dir, 'meetings', 'slug');
    fs.mkdirSync(f, { recursive: true });
    fs.writeFileSync(path.join(f, 'transcript.md'), '[SPEAKER_00 00:00] Hi.');

    const chat = vi.fn(async () => '## Overview\nx.\n\n# Off-topic Conversation\n- Weekend plans.');
    const ctx: any = {
      libraryRoot: dir,
      llmSupervisor: { ensureReady: async () => {} },
      lmStudio: { chat },
      meetings: { findById: () => ({ slug: 'slug', title: 'Team sync' }), updateTitle: vi.fn() },
      settings: { get: (k: string) => (k === 'llmModel' ? 'llama-3.1-8b' : 'detailed') },
      logger: { info: () => {} },
    };
    await runSummarizing({ meetingId: 'm' }, ctx);
    const out = fs.readFileSync(path.join(f, 'summary.md'), 'utf8');
    expect(out).toContain('## Off-topic Conversation');
    expect(out).not.toMatch(/^# Off-topic Conversation/m);
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
