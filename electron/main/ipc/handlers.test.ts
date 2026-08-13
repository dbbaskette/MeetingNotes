import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerIpcHandlers } from './handlers.js';
import { LMStudioError } from '../lm-studio/client.js';
import { remergeTranscript } from '../pipeline/stages/merging.js';

// Mock the merge step so speaker rename/merge tests can assert the re-merge
// fan-out without needing real transcript files on disk.
vi.mock('../pipeline/stages/merging.js', () => ({
  remergeTranscript: vi.fn(),
  runMerging: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(remergeTranscript).mockClear();
});

function baseServices(overrides: Record<string, unknown> = {}): any {
  return {
    meetings: { listAll: () => [] },
    speakers: { list: () => [] },
    actionItems: { listByMeeting: () => [] },
    settings: { getAll: () => ({}), get: () => '', set: () => {} },
    lmStudio: { listModels: async () => [] },
    recordingManager: { start: async () => ({ sessionId: 's', outputPath: '/o' }), stop: async () => {}, state: () => 'idle', on: () => {} },
    recordingRecovery: { list: async () => [], recover: async () => ({}), trim: async () => ({}), reveal: () => {}, dismiss: () => {} },
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
    // Light detail-view status poll (no transcript/summary file reads).
    expect(channels).toContain('meetings:get-status');
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
    // Reveal a storage location (library/models/logs/hfCache) in Finder.
    expect(channels).toContain('settings:reveal-storage');
    expect(channels).toContain('trash:list');
    // Roster management (rename existed already; merge is new).
    expect(channels).toContain('speakers:rename');
    expect(channels).toContain('speakers:merge');
    expect(channels).toContain('speakers:assign-bulk');
    expect(channels).toContain('recovery:list');
  });

  it('speakers:assign-bulk links every label and re-merges once', () => {
    const linkToMeeting = vi.fn();
    const handle = vi.fn();
    registerIpcHandlers({ handle } as any, baseServices({
      meetings: { listAll: () => [], findById: () => ({ id: 'm1', slug: 'meeting-1' }) },
      speakers: {
        list: () => [], findById: (id: string) => id === 'spk_a' ? { id, displayName: 'Alice' } : null,
        listForMeeting: () => [],
        linkToMeeting,
      },
    }));
    const call = handle.mock.calls.find((c) => c[0] === 'speakers:assign-bulk');
    const handler = call![1] as (event: unknown, input: unknown) => { assigned: number; impactedLines: number };

    const result = handler(null, { meetingId: 'm1', localLabels: ['SPEAKER_00', 'SPEAKER_01'], rosterId: 'spk_a' });

    expect(linkToMeeting.mock.calls).toEqual([
      ['m1', 'SPEAKER_00', 'spk_a', 1],
      ['m1', 'SPEAKER_01', 'spk_a', 1],
    ]);
    expect(vi.mocked(remergeTranscript)).toHaveBeenCalledTimes(1);
    expect(result.assigned).toBe(2);
  });

  it('speakers:rename updates the roster row and re-merges every affected transcript', () => {
    const rename = vi.fn();
    const handle = vi.fn();
    const fakeIpc = { handle } as any;
    const services = baseServices({
      speakers: {
        list: () => [],
        rename,
        meetingIdsForSpeaker: vi.fn(() => ['m1', 'm2']),
      },
    });
    registerIpcHandlers(fakeIpc, services);
    const call = handle.mock.calls.find((c) => c[0] === 'speakers:rename');
    expect(call).toBeDefined();
    const handler = call![1] as (e: unknown, id: unknown, name: unknown) => void;

    handler(null, 'spk_1', 'Dan Baskette');

    expect(rename).toHaveBeenCalledWith('spk_1', 'Dan Baskette');
    // Both linked meetings get their transcript.md rewritten with the new name.
    expect(vi.mocked(remergeTranscript).mock.calls.map((c) => c[0])).toEqual(['m1', 'm2']);

    expect(() => handler(null, 42 as unknown, 'x')).toThrow(/invalid args/);
  });

  it('speakers:merge validates ids, merges via the repo, and re-merges affected transcripts', () => {
    const mergeSpeakers = vi.fn(() => ['m1', 'm3']);
    const known = new Set(['spk_a', 'spk_b']);
    const stored: Record<string, unknown> = { userSpeakerId: 'spk_a' };
    const handle = vi.fn();
    const fakeIpc = { handle } as any;
    const services = baseServices({
      speakers: {
        list: () => [],
        findById: (id: string) => (known.has(id) ? { id, displayName: id } : null),
        mergeSpeakers,
      },
      settings: {
        getAll: () => ({}),
        get: (key: string) => stored[key] ?? '',
        set: (key: string, value: unknown) => { stored[key] = value; },
      },
    });
    registerIpcHandlers(fakeIpc, services);
    const call = handle.mock.calls.find((c) => c[0] === 'speakers:merge');
    expect(call).toBeDefined();
    const handler = call![1] as (e: unknown, src: unknown, tgt: unknown) => { affectedMeetingIds: string[] };

    // Bad inputs never reach the repo.
    expect(() => handler(null, '', 'spk_b')).toThrow(/invalid args/);
    expect(() => handler(null, 'spk_a', 42)).toThrow(/invalid args/);
    expect(() => handler(null, 'spk_a', 'spk_a')).toThrow(/cannot merge a speaker into itself/);
    expect(() => handler(null, 'spk_nope', 'spk_b')).toThrow(/source speaker not found/);
    expect(() => handler(null, 'spk_a', 'spk_nope')).toThrow(/target speaker not found/);
    expect(mergeSpeakers).not.toHaveBeenCalled();

    const result = handler(null, 'spk_a', 'spk_b');

    expect(mergeSpeakers).toHaveBeenCalledWith('spk_a', 'spk_b');
    expect(result.affectedMeetingIds).toEqual(['m1', 'm3']);
    // Each affected meeting's transcript is rewritten with the survivor's name.
    expect(vi.mocked(remergeTranscript).mock.calls.map((c) => c[0])).toEqual(['m1', 'm3']);
    // The "You are…" pointer follows the merge when it referenced the source.
    expect(stored.userSpeakerId).toBe('spk_b');
  });

  it('trash:list purges expired entries then returns the rest, newest first', () => {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const rows = [
      { id: 'old', title: 'Ancient standup', deletedAt: new Date(now - 40 * day).toISOString() },
      { id: 'a', title: 'Design sync', deletedAt: new Date(now - 2 * day).toISOString() },
      { id: 'b', title: 'Retro', deletedAt: new Date(now - 1 * day).toISOString() },
    ];
    const hardDelete = vi.fn((id: string) => {
      const i = rows.findIndex((r) => r.id === id);
      if (i >= 0) rows.splice(i, 1);
    });
    const findSoftDeleted = vi.fn((olderThanIso?: string) =>
      olderThanIso ? rows.filter((r) => r.deletedAt < olderThanIso) : [...rows]);
    const handle = vi.fn();
    const fakeIpc = { handle } as any;
    const services = baseServices({
      meetings: { listAll: () => [], findSoftDeleted, hardDelete },
    });
    registerIpcHandlers(fakeIpc, services);
    const call = handle.mock.calls.find((c) => c[0] === 'trash:list');
    expect(call).toBeDefined();
    const handler = call![1] as () => { id: string; title: string; deletedAt: string }[];

    const list = handler();

    // The 40-day-old entry is past the 30-day retention window: purged…
    expect(hardDelete).toHaveBeenCalledTimes(1);
    expect(hardDelete).toHaveBeenCalledWith('old');
    // …and the survivors come back newest-deletion first.
    expect(list.map((m) => m.id)).toEqual(['b', 'a']);
    expect(list[0]).toEqual({ id: 'b', title: 'Retro', deletedAt: rows[1]!.deletedAt });
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

    // Sent the summary with the strict extract prompt, room to reason (6000),
    // and the re-sample retry that clears an intermittent spiral.
    const arg = chat.mock.calls[0]![0] as { maxTokens: number; resampleRetries: number; messages: { content: string }[] };
    expect(arg.maxTokens).toBe(6000);
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

  it('action-items:set-status whitelists the status value and validates the id', () => {
    const setStatus = vi.fn();
    const handle = vi.fn();
    const fakeIpc = { handle } as any;
    const services = baseServices({
      actionItems: { listByMeeting: () => [], setStatus },
    });
    registerIpcHandlers(fakeIpc, services);
    const call = handle.mock.calls.find((c) => c[0] === 'action-items:set-status');
    expect(call).toBeDefined();
    const handler = call![1] as (e: unknown, id: unknown, status: unknown) => unknown;

    handler(null, 'ai-1', 'done');
    expect(setStatus).toHaveBeenCalledWith('ai-1', 'done');
    handler(null, 'ai-1', 'open');
    expect(setStatus).toHaveBeenCalledWith('ai-1', 'open');

    // Anything outside the open|done whitelist is rejected before the store.
    expect(() => handler(null, 'ai-1', 'archived')).toThrow(/invalid status/);
    expect(() => handler(null, 'ai-1', 42)).toThrow(/invalid status/);
    // Bad ids never reach the store either.
    expect(() => handler(null, '', 'done')).toThrow(/invalid args/);
    expect(() => handler(null, 42, 'done')).toThrow(/invalid args/);
    expect(setStatus).toHaveBeenCalledTimes(2);
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
