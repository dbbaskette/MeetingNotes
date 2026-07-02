import { describe, it, expect, vi } from 'vitest';
import { registerIpcHandlers } from './handlers.js';
import { LMStudioError } from '../lm-studio/client.js';

function baseServices(overrides: Record<string, unknown> = {}): any {
  return {
    meetings: { listAll: () => [] },
    speakers: { list: () => [] },
    actionItems: { listByMeeting: () => [] },
    settings: { getAll: () => ({}), get: () => '', set: () => {} },
    lmStudio: { listModels: async () => [] },
    recordingManager: { start: async () => ({ sessionId: 's', outputPath: '/o' }), stop: async () => {}, state: () => 'idle', on: () => {} },
    appEnumerator: { list: async () => [] },
    helperPath: '/bin/meeting-notes-tap',
    roster: { confirmSpeaker: () => 'id', confirmSpeakerFor: () => {} },
    pipeline: {
      enqueue: () => {},
      getStatus: () => ({ paused: false, currentId: null, queueLength: 0, queueIds: [] }),
      pause: () => {},
      resume: () => {},
      clearQueue: () => [],
    },
    exporters: {},
    libraryRoot: '/tmp',
    llmSupervisor: { ensureReady: async () => {} },
    logger: { info: () => {}, error: () => {} },
    gateNotified: new Set<string>(),
    ...overrides,
  };
}

describe('registerIpcHandlers', () => {
  it('registers all known channels', () => {
    const handle = vi.fn();
    const fakeIpc = { handle } as any;
    registerIpcHandlers(fakeIpc, baseServices());
    const channels = handle.mock.calls.map((c) => c[0]);
    expect(channels).toContain('meetings:list');
    expect(channels).toContain('meetings:get');
    expect(channels).toContain('export:run');
    expect(channels).toContain('models:list');
    // New endpoints from the UX-review pass: Settings "Test connection"
    // probes (one per LLM/STT side) and the drag-and-drop import handler.
    expect(channels).toContain('stt:probe');
    expect(channels).toContain('llm:probe');
    expect(channels).toContain('meetings:import-dropped');
    expect(channels).toContain('transcript:export');
    // Queue controls (pause / resume / clear / status snapshot).
    expect(channels).toContain('pipeline:pause');
    expect(channels).toContain('pipeline:resume');
    expect(channels).toContain('pipeline:clear');
    expect(channels).toContain('pipeline:status');
    // Reasoning-model health check.
    expect(channels).toContain('llm:health-check-model');
    // Re-extract action items from the edited summary.
    expect(channels).toContain('action-items:reextract');
  });

  it('llm:health-check-model reports ok for a well-behaved model and loops for one that burns its budget', async () => {
    const handle = vi.fn();
    const fakeIpc = { handle } as any;
    const stored: Record<string, unknown> = {};
    const chat = vi.fn()
      .mockResolvedValueOnce('[]')
      .mockRejectedValueOnce(new LMStudioError(
        'LM Studio produced no answer — the model spent its entire token budget "thinking" (~500 reasoning words) without writing any output.',
      ));
    const services = baseServices({
      settings: {
        getAll: () => ({}),
        get: (key: string) => stored[key] ?? {},
        set: (key: string, value: unknown) => { stored[key] = value; },
      },
      lmStudio: { listModels: async () => [], chat },
    });
    registerIpcHandlers(fakeIpc, services);
    const call = handle.mock.calls.find((c) => c[0] === 'llm:health-check-model');
    expect(call).toBeDefined();
    const handler = call![1] as (e: unknown, modelId: unknown) => Promise<{ verdict: string; checkedAt: string }>;

    const ok = await handler(null, 'good-model');
    expect(ok.verdict).toBe('ok');

    const loops = await handler(null, 'bad-model');
    expect(loops.verdict).toBe('loops');

    // Both verdicts get cached under their model id.
    const cache = stored.modelHealthChecks as Record<string, { verdict: string }>;
    expect(cache['good-model']!.verdict).toBe('ok');
    expect(cache['bad-model']!.verdict).toBe('loops');
  });

  it('llm:health-check-model re-throws a genuine (non-reasoning-loop) error', async () => {
    const handle = vi.fn();
    const fakeIpc = { handle } as any;
    const chat = vi.fn().mockRejectedValueOnce(new LMStudioError('LM Studio 500 on /v1/chat/completions'));
    const services = baseServices({ lmStudio: { listModels: async () => [], chat } });
    registerIpcHandlers(fakeIpc, services);
    const call = handle.mock.calls.find((c) => c[0] === 'llm:health-check-model');
    const handler = call![1] as (e: unknown, modelId: unknown) => Promise<unknown>;
    await expect(handler(null, 'some-model')).rejects.toThrow('LM Studio 500');
  });

  it('action-items:reextract re-runs extract over summary.md and replaces the items', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-re-'));
    const folder = path.join(dir, 'meetings', 'slug');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(
      path.join(folder, 'summary.md'),
      '## Action Items\n- Send the update — Dan — 2026-04-22',
    );

    const chat = vi.fn().mockResolvedValue(
      '[{"text":"Send the update","owner":"Dan","due_date":"2026-04-22"}]',
    );
    const replaceForMeeting = vi.fn();
    const handle = vi.fn();
    const fakeIpc = { handle } as any;
    const services = baseServices({
      libraryRoot: dir,
      meetings: { listAll: () => [], findById: () => ({ id: 'm', slug: 'slug' }) },
      actionItems: { listByMeeting: () => [], replaceForMeeting },
      settings: { getAll: () => ({}), get: () => 'llama-3.1-8b', set: () => {} },
      lmStudio: { listModels: async () => [], chat },
    });
    registerIpcHandlers(fakeIpc, services);
    const call = handle.mock.calls.find((c) => c[0] === 'action-items:reextract');
    expect(call).toBeDefined();
    const handler = call![1] as (e: unknown, id: unknown) => Promise<{ count: number }>;

    const result = await handler(null, 'm');

    // Sent the summary with the strict extract prompt, room to reason (4000),
    // and the re-sample retry that clears an intermittent spiral.
    const arg = chat.mock.calls[0]![0] as { maxTokens: number; resampleRetries: number; messages: { content: string }[] };
    expect(arg.maxTokens).toBe(4000);
    expect(arg.resampleRetries).toBe(2);
    expect(arg.messages[1]!.content).toContain('## Action Items');
    // Replaced the meeting's items with the parsed output and reported the count.
    expect(replaceForMeeting).toHaveBeenCalledWith(
      'm',
      expect.arrayContaining([expect.objectContaining({ text: 'Send the update' })]),
    );
    expect(result.count).toBe(1);
    // Persisted the JSON snapshot alongside the summary.
    expect(fs.existsSync(path.join(folder, 'action-items.json'))).toBe(true);
  });

  it('clearing the speaker-ID gate flag lets a re-entry notify again', () => {
    const gateNotified = new Set<string>(['m1']); // already notified this visit
    const handle = vi.fn();
    const fakeIpc = { handle } as any;
    const services = baseServices({
      gateNotified,
      libraryRoot: '/tmp/mn-gate-clear',
      settings: { getAll: () => ({}), get: () => '', set: () => {} },
      speakers: { list: () => [], listForMeeting: () => [] },
      meetings: {
        listAll: () => [],
        findById: () => ({ id: 'm1', slug: 'm1', pipelineStage: 'awaiting_speaker_id', status: 'awaiting_user' }),
        updateStage: () => {},
        updateStatus: () => {},
      },
    });
    registerIpcHandlers(fakeIpc, services);
    const call = handle.mock.calls.find((c) => c[0] === 'meetings:continue-from-speaker-id');
    expect(call).toBeDefined();
    const handler = call![1] as (e: unknown, id: unknown) => void;
    handler(null, 'm1');
    expect(gateNotified.has('m1')).toBe(false);
  });

  it('action-items:reextract throws (without calling the LLM) when summary.md is missing', async () => {
    const chat = vi.fn();
    const handle = vi.fn();
    const fakeIpc = { handle } as any;
    const services = baseServices({
      libraryRoot: '/tmp/does-not-exist-mn',
      meetings: { listAll: () => [], findById: () => ({ id: 'm', slug: 'no-such-slug' }) },
      lmStudio: { listModels: async () => [], chat },
    });
    registerIpcHandlers(fakeIpc, services);
    const call = handle.mock.calls.find((c) => c[0] === 'action-items:reextract');
    const handler = call![1] as (e: unknown, id: unknown) => Promise<unknown>;
    await expect(handler(null, 'm')).rejects.toThrow(/summary\.md is missing or empty/);
    expect(chat).not.toHaveBeenCalled();
  });
});
