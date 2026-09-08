import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerIpcHandlers } from './handlers.js';
import { LMStudioError } from '../lm-studio/client.js';
import { remergeTranscript } from '../pipeline/stages/merging.js';
import { ArtifactCache } from '../library/artifact-cache.js';
import { openDb } from '../storage/db.js';
import { MeetingsRepo } from '../storage/meetings-repo.js';
import { SpeakersRepo } from '../storage/speakers-repo.js';
import { ActionItemsRepo } from '../storage/action-items-repo.js';

// Mock the merge step so speaker rename/merge tests can assert the re-merge
// fan-out without needing real transcript files on disk.
vi.mock('../pipeline/stages/merging.js', () => ({
  remergeTranscript: vi.fn(),
  runMerging: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(remergeTranscript).mockClear();
});

describe('paginated meeting summaries', () => {
  let db: ReturnType<typeof openDb>;
  let meetings: MeetingsRepo;
  let speakers: SpeakersRepo;
  let actionItems: ActionItemsRepo;
  let handlers: Map<string, (...args: any[]) => any>;
  const insert = (id: string, status = 'done') => meetings.insert({
    id, slug: id, title: id, startedAt: '2026-09-01T12:00:00Z', durationS: 60,
    audioPath: `/audio/${id}`, status, pipelineStage: 'done',
  });
  const invoke = (channel: string, input?: unknown) => {
    const handler = handlers.get(channel);
    expect(handler, `${channel} must be registered`).toBeTypeOf('function');
    return handler!(null, input);
  };
  beforeEach(() => {
    db = openDb(':memory:');
    meetings = new MeetingsRepo(db);
    speakers = new SpeakersRepo(db);
    actionItems = new ActionItemsRepo(db);
    handlers = new Map();
    registerIpcHandlers({ handle: (channel: string, handler: any) => handlers.set(channel, handler) } as any,
      baseServices({ meetings, speakers, actionItems }));
  });
  afterEach(() => db.close());

  it('defaults to 50, caps at 100, and returns library-wide counts with a filtered total', () => {
    for (let i = 0; i < 105; i++) insert(`done-${String(i).padStart(3, '0')}`);
    insert('pending', 'pending');
    insert('gate', 'awaiting_user');
    insert('processing', 'processing');
    insert('failed', 'failed');
    insert('deleted');
    db.prepare('UPDATE meetings SET deleted_at = ? WHERE id = ?').run('2026-09-08', 'deleted');
    const query = { filter: 'done', sort: 'newest' };
    const first = invoke('meetings:list-page', query);
    expect(first.items).toHaveLength(50);
    expect(first.total).toBe(105);
    expect(first.counts).toEqual({ all: 109, pending: 1, processing: 2, done: 105, failed: 1 });
    const capped = invoke('meetings:list-page', { ...query, pageSize: 1000 });
    expect(capped.items).toHaveLength(100);
    const last = invoke('meetings:list-page', { ...query, cursor: capped.nextCursor });
    expect(last.items.map((m: any) => m.id)).toEqual(['done-100', 'done-101', 'done-102', 'done-103', 'done-104']);
    expect(last.nextCursor).toBeNull();
    expect(invoke('meetings:list-ids', 'processing')).toEqual(['gate', 'processing']);
  });

  it.each([
    { filter: 'bogus', sort: 'newest' }, { filter: 'all', sort: 'DROP TABLE meetings' },
    { filter: 'all', sort: 'newest', pageSize: 0 }, { filter: 'all', sort: 'newest', pageSize: 1.5 },
    { filter: 'all', sort: 'newest', pageSize: Infinity }, { filter: 'all', sort: 'newest', pageSize: '50' },
    { filter: 'all', sort: 'newest', cursor: '' }, { filter: 'all', sort: 'newest', cursor: 'not-json' },
    { filter: 'all', sort: 'newest', cursor: null },
    { filter: 'all', sort: 'newest', cursor: Buffer.from(JSON.stringify({ v: 1, statusRank: 4, id: 'x', sortValue: { sort: 'title', values: ['x', null] } })).toString('base64url') },
    { filter: 'all', sort: 'newest', cursor: Buffer.from(JSON.stringify({ v: 1, statusRank: 4, id: 'x', sortValue: { sort: 'newest', values: [42] } })).toString('base64url') },
  ])('rejects invalid query input before repository work: %j', (query) => {
    expect(handlers.has('meetings:list-page')).toBe(true);
    const page = vi.spyOn(meetings, 'listPage');
    expect(() => invoke('meetings:list-page', query)).toThrow();
    expect(page).not.toHaveBeenCalled();
  });

  it('rejects invalid ID filters and hydration inputs, including over-limit duplicates', () => {
    expect(handlers.has('meetings:list-ids')).toBe(true);
    expect(handlers.has('meetings:get-many')).toBe(true);
    const find = vi.spyOn(meetings, 'findByIds');
    const listIds = vi.spyOn(meetings, 'listIds');
    expect(() => invoke('meetings:list-ids', 'awaiting_user')).toThrow();
    expect(listIds).not.toHaveBeenCalled();
    for (const input of [null, 'm1', [''], [1], Array(1001).fill('m1')]) {
      expect(() => invoke('meetings:get-many', input)).toThrow();
    }
    expect(find).not.toHaveBeenCalled();
    expect(invoke('meetings:get-many', Array(1000).fill('missing'))).toEqual([]);
    expect(find).toHaveBeenLastCalledWith(['missing']);
  });

  it('enriches only page/hydrated IDs, preserves summary shape and first-occurrence order', () => {
    for (const id of ['a', 'b', 'outside', 'deleted']) insert(id);
    db.prepare('UPDATE meetings SET deleted_at = ? WHERE id = ?').run('2026-09-08', 'deleted');
    const rosterId = speakers.create({ displayName: 'Alex' });
    speakers.linkToMeeting('a', 'SPEAKER_00', rosterId, 1);
    speakers.linkToMeeting('a', 'SPEAKER_01', null, 0);
    speakers.linkToMeeting('outside', 'SPEAKER_00', null, 0);
    actionItems.create('a', { text: 'One' });
    actionItems.create('a', { text: 'Two' });
    actionItems.create('outside', { text: 'Excluded' });
    const legacy = invoke('meetings:list');
    const allSpeakers = vi.spyOn(speakers, 'listForAllMeetings');
    const allCounts = vi.spyOn(actionItems, 'countsByMeeting');
    const scopedSpeakers = vi.spyOn(speakers, 'listForMeetings');
    const scopedCounts = vi.spyOn(actionItems, 'countsForMeetings');
    const page = invoke('meetings:list-page', { filter: 'all', sort: 'newest', pageSize: 1 });
    expect(page.items).toEqual([legacy.find((m: any) => m.id === 'a')]);
    expect(page.items[0]).toMatchObject({ unidentifiedCount: 1, actionItemsCount: 2, stageEtaMs: null, stageEtaRough: false });
    expect(scopedSpeakers).toHaveBeenLastCalledWith(['a']);
    expect(scopedCounts).toHaveBeenLastCalledWith(['a']);
    const hydrated = invoke('meetings:get-many', ['b', 'missing', 'a', 'b', 'deleted']);
    expect(hydrated.map((m: any) => m.id)).toEqual(['b', 'a']);
    expect(hydrated[1]).toEqual(page.items[0]);
    expect(scopedSpeakers).toHaveBeenLastCalledWith(['b', 'a']);
    expect(scopedCounts).toHaveBeenLastCalledWith(['b', 'a']);
    expect(allSpeakers).not.toHaveBeenCalled();
    expect(allCounts).not.toHaveBeenCalled();
    scopedSpeakers.mockClear(); scopedCounts.mockClear();
    expect(invoke('meetings:get-many', [])).toEqual([]);
    expect(scopedSpeakers).not.toHaveBeenCalled();
    expect(scopedCounts).not.toHaveBeenCalled();
  });
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
    artifactCache: new ArtifactCache(),
    llmSupervisor: { ensureReady: async () => {} },
    logger: { info: () => {}, error: () => {} },
    gateNotified: new Set<string>(),
    ...overrides,
  };
}

describe('registerIpcHandlers', () => {
  it('summary save refreshes the shared cache even with an unchanged fingerprint', async () => {
    const libraryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mn-save-cache-'));
    try {
      const folder = path.join(libraryRoot, 'meetings', 'slug');
      await fs.mkdir(folder, { recursive: true });
      const summaryPath = path.join(folder, 'summary.md');
      await fs.writeFile(summaryPath, 'Old summary');
      const artifactCache = new ArtifactCache({
        stat: async (filePath) => ({ size: (await fs.stat(filePath)).size, mtimeMs: 1, ctimeMs: 1 }),
      });
      const handle = vi.fn();
      registerIpcHandlers({ handle } as any, baseServices({
        libraryRoot, artifactCache,
        meetings: { findById: () => ({ id: 'm1', slug: 'slug' }) },
        speakers: { listForMeeting: () => [] },
      }));
      const get = handle.mock.calls.find(([channel]) => channel === 'meetings:get')![1];
      const save = handle.mock.calls.find(([channel]) => channel === 'meetings:save-summary')![1];
      expect((await get(null, 'm1')).summaryMd).toBe('Old summary');

      const writeFileSync = fsSync.writeFileSync.bind(fsSync);
      let entriesAtWrite = -1;
      const write = vi.spyOn(fsSync, 'writeFileSync').mockImplementation((...args) => {
        entriesAtWrite = artifactCache.stats().entries;
        return writeFileSync(...args);
      });
      try {
        expect(save(null, 'm1', 'New summary')).toBe('New summary');
      } finally {
        write.mockRestore();
      }

      expect((await get(null, 'm1')).summaryMd).toBe('New summary');
      expect(entriesAtWrite).toBe(0);
    } finally {
      await fs.rm(libraryRoot, { recursive: true, force: true });
    }
  });

  it.each([
    'speakers:rename', 'meetings:set-skip-speaker-id', 'meetings:continue-from-speaker-id',
  ])('%s remerges with the shared cache and refreshes transcript bytes', async (channel) => {
    const libraryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mn-rename-cache-'));
    try {
      const folder = path.join(libraryRoot, 'meetings', 'slug');
      await fs.mkdir(folder, { recursive: true });
      await fs.writeFile(path.join(folder, 'transcript.raw.json'), JSON.stringify({
        segments: [{ start: 0, end: 1, text: 'Hi.' }],
      }));
      await fs.writeFile(path.join(folder, 'diarization.json'), JSON.stringify({
        segments: [{ start: 0, end: 1, speaker: 'SPEAKER_00' }],
      }));
      await fs.writeFile(path.join(folder, 'transcript.md'), '[Alice 00:00] Hi.');
      const artifactCache = new ArtifactCache({
        stat: async (filePath) => ({ size: (await fs.stat(filePath)).size, mtimeMs: 1, ctimeMs: 1 }),
      });
      // Exercise the actual writer for this integration test; other tests only
      // need the mocked fan-out because they have no transcript files.
      const actual = await vi.importActual<typeof import('../pipeline/stages/merging.js')>('../pipeline/stages/merging.js');
      vi.mocked(remergeTranscript).mockImplementationOnce(actual.remergeTranscript);
      const handle = vi.fn();
      registerIpcHandlers({ handle } as any, baseServices({
        libraryRoot, artifactCache,
        meetings: {
          findById: () => ({ id: 'm1', slug: 'slug', pipelineStage: 'awaiting_speaker_id' }),
          updateSkipSpeakerId: () => {}, updateStatus: () => {}, updateStage: () => {},
        },
        speakers: {
          rename: () => {},
          meetingIdsForSpeaker: () => ['m1'],
          listForMeeting: () => [{ localLabel: 'SPEAKER_00', displayName: 'Bobby' }],
        },
      }));
      const get = handle.mock.calls.find(([channel]) => channel === 'meetings:get-transcript')![1];
      const mutate = handle.mock.calls.find(([registered]) => registered === channel)![1];
      expect((await get(null, 'm1')).transcriptMd).toBe('[Alice 00:00] Hi.');

      if (channel === 'speakers:rename') mutate(null, 'speaker-1', 'Bobby');
      else mutate(null, 'm1', true);

      expect((await get(null, 'm1')).transcriptMd).toBe('[Bobby 00:00] Hi.');
    } finally {
      await fs.rm(libraryRoot, { recursive: true, force: true });
    }
  });

  it('rerun invalidates the shared cache before artifacts are recreated', async () => {
    const libraryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mn-rerun-cache-'));
    try {
      const folder = path.join(libraryRoot, 'meetings', 'slug');
      const summaryPath = path.join(folder, 'summary.md');
      await fs.mkdir(folder, { recursive: true });
      await fs.writeFile(summaryPath, 'Old summary');
      const artifactCache = new ArtifactCache({
        stat: async (filePath) => ({ size: (await fs.stat(filePath)).size, mtimeMs: 1, ctimeMs: 1 }),
      });
      const handle = vi.fn();
      registerIpcHandlers({ handle } as any, baseServices({
        libraryRoot, artifactCache,
        meetings: {
          findById: () => ({ id: 'm1', slug: 'slug' }),
          updateStatus: () => {}, updateStage: () => {},
        },
        speakers: { listForMeeting: () => [] },
        actionItems: { listByMeeting: () => [], deleteForMeeting: () => {} },
      }));
      const get = handle.mock.calls.find(([channel]) => channel === 'meetings:get')![1];
      const rerun = handle.mock.calls.find(([channel]) => channel === 'meetings:rerun')![1];
      expect((await get(null, 'm1')).summaryMd).toBe('Old summary');
      rerun(null, 'm1', 'summarizing');
      await fs.writeFile(summaryPath, 'New summary');
      expect((await get(null, 'm1')).summaryMd).toBe('New summary');
    } finally {
      await fs.rm(libraryRoot, { recursive: true, force: true });
    }
  });

  it('registers all known channels', () => {
    const handle = vi.fn();
    const fakeIpc = { handle } as any;
    registerIpcHandlers(fakeIpc, baseServices());
    const channels = handle.mock.calls.map((c) => c[0]);
    expect(channels).toContain('meetings:list');
    expect(channels).toContain('meetings:get');
    expect(channels).toContain('meetings:get-transcript');
    expect(channels).toContain('meetings:get-speaker-review');
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

  it('loads only the summary into the async meeting shell', async () => {
    const libraryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mn-artifact-shell-'));
    const folder = path.join(libraryRoot, 'meetings', 'design-sync');
    await fs.mkdir(folder, { recursive: true });
    const summaryPath = path.join(folder, 'summary.md');
    const transcriptPath = path.join(folder, 'transcript.md');
    const rawPath = path.join(folder, 'transcript.raw.json');
    const diarizationPath = path.join(folder, 'diarization.json');
    await Promise.all([
      fs.writeFile(summaryPath, '# Summary\nDecision recorded.'),
      fs.writeFile(transcriptPath, 'x'.repeat(2 * 1024 * 1024)),
      fs.writeFile(rawPath, JSON.stringify({ text: 'Early raw preview', segments: [] })),
      fs.writeFile(diarizationPath, JSON.stringify({ segments: [] })),
    ]);
    const readText = vi.fn(async (filePath: string) => fs.readFile(filePath, 'utf8').catch(() => null));
    const readJson = vi.fn(async (filePath: string) => {
      const source = await fs.readFile(filePath, 'utf8').catch(() => null);
      return source === null ? null : JSON.parse(source);
    });
    const handle = vi.fn();
    registerIpcHandlers({ handle } as any, baseServices({
      libraryRoot,
      artifactCache: { readText, readJson },
      meetings: {
        listAll: () => [],
        findById: (id: string) => id === 'm1' ? {
          id, slug: 'design-sync', title: 'Design sync', startedAt: null, durationS: null,
          pipelineStage: 'done', status: 'done', errorMessage: null, stageStartedAt: null,
          skipSpeakerId: false, audioPath: '/audio/design-sync.m4a',
        } : null,
      },
      speakers: {
        list: () => [],
        listForMeeting: () => [{
          localLabel: 'SPEAKER_00', rosterSpeakerId: 'spk-alice', displayName: 'Alice', confidence: 1,
        }],
      },
    }));
    const get = handle.mock.calls.find((call) => call[0] === 'meetings:get')![1] as (
      event: unknown, id: unknown,
    ) => Promise<Record<string, unknown> | null>;

    const shell = await get(null, 'm1');

    expect(shell).toMatchObject({ summaryMd: '# Summary\nDecision recorded.' });
    expect(shell).not.toHaveProperty('transcriptMd');
    expect(shell).not.toHaveProperty('rawTranscriptText');
    expect(shell?.speakers).toEqual([{
      localLabel: 'SPEAKER_00', rosterId: 'spk-alice', displayName: 'Alice', confidence: 1,
    }]);
    expect(readText).toHaveBeenCalledWith(summaryPath);
    expect(readText).not.toHaveBeenCalledWith(transcriptPath);
    expect(readJson).not.toHaveBeenCalledWith(rawPath);
    expect(readJson).not.toHaveBeenCalledWith(diarizationPath);
  });

  it('loads transcript markdown and early raw preview through the transcript artifact handler', async () => {
    const libraryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mn-transcript-artifact-'));
    const folder = path.join(libraryRoot, 'meetings', 'design-sync');
    await fs.mkdir(folder, { recursive: true });
    const transcriptPath = path.join(folder, 'transcript.md');
    const rawPath = path.join(folder, 'transcript.raw.json');
    await Promise.all([
      fs.writeFile(transcriptPath, 'Alice: Decision recorded.'),
      fs.writeFile(rawPath, JSON.stringify({ text: 'Early raw preview', segments: [] })),
    ]);
    const readText = vi.fn(async (filePath: string) => fs.readFile(filePath, 'utf8').catch(() => null));
    const readJson = vi.fn(async (filePath: string) => {
      const source = await fs.readFile(filePath, 'utf8').catch(() => null);
      return source === null ? null : JSON.parse(source);
    });
    const handle = vi.fn();
    registerIpcHandlers({ handle } as any, baseServices({
      libraryRoot,
      artifactCache: { readText, readJson },
      meetings: { listAll: () => [], findById: (id: string) => id === 'm1' ? { id, slug: 'design-sync' } : null },
    }));
    const getTranscript = handle.mock.calls.find((call) => call[0] === 'meetings:get-transcript')![1] as (
      event: unknown, id: unknown,
    ) => Promise<{ transcriptMd: string | null; rawTranscriptText: string | null } | null>;

    await expect(getTranscript(null, 'm1')).resolves.toEqual({
      transcriptMd: 'Alice: Decision recorded.', rawTranscriptText: 'Early raw preview',
    });
    expect(readText).toHaveBeenCalledWith(transcriptPath);
    expect(readJson).toHaveBeenCalledWith(rawPath);
  });

  it('loads speaker review metadata through the speaker-review artifact handler', async () => {
    const libraryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mn-review-artifact-'));
    const folder = path.join(libraryRoot, 'meetings', 'design-sync');
    await fs.mkdir(folder, { recursive: true });
    const rawPath = path.join(folder, 'transcript.raw.json');
    const diarizationPath = path.join(folder, 'diarization.json');
    await Promise.all([
      fs.writeFile(rawPath, JSON.stringify({ segments: [{ start: 0, end: 4, text: 'Decision recorded.' }] })),
      fs.writeFile(diarizationPath, JSON.stringify({ segments: [{ start: 0, end: 4, speaker: 'SPEAKER_00' }] })),
    ]);
    const readJson = vi.fn(async (filePath: string) => {
      const source = await fs.readFile(filePath, 'utf8').catch(() => null);
      return source === null ? null : JSON.parse(source);
    });
    const handle = vi.fn();
    registerIpcHandlers({ handle } as any, baseServices({
      libraryRoot,
      artifactCache: { readText: async () => null, readJson },
      meetings: { listAll: () => [], findById: (id: string) => id === 'm1' ? { id, slug: 'design-sync' } : null },
      speakers: {
        list: () => [],
        listForMeeting: () => [{
          localLabel: 'SPEAKER_00', rosterSpeakerId: 'spk-alice', displayName: 'Alice', confidence: 1,
        }],
      },
    }));
    const getSpeakerReview = handle.mock.calls.find((call) => call[0] === 'meetings:get-speaker-review')![1] as (
      event: unknown, id: unknown,
    ) => Promise<{ speakers: unknown[] } | null>;

    await expect(getSpeakerReview(null, 'm1')).resolves.toEqual({
      speakers: [{
        localLabel: 'SPEAKER_00', rosterId: 'spk-alice', displayName: 'Alice', confidence: 1,
        state: 'confirmed', needsReview: true, segmentCount: 1, durationS: 4, lineCount: 1,
      }],
    });
    expect(readJson).toHaveBeenCalledWith(rawPath);
    expect(readJson).toHaveBeenCalledWith(diarizationPath);
  });

  it('returns null for unknown meeting IDs from every detail-artifact handler', async () => {
    const handle = vi.fn();
    registerIpcHandlers({ handle } as any, baseServices({
      meetings: { listAll: () => [], findById: () => null },
    }));
    const handler = (channel: string) => handle.mock.calls.find((call) => call[0] === channel)![1] as (
      event: unknown, id: unknown,
    ) => Promise<unknown>;

    await expect(handler('meetings:get')(null, 'missing')).resolves.toBeNull();
    await expect(handler('meetings:get-transcript')(null, 'missing')).resolves.toBeNull();
    await expect(handler('meetings:get-speaker-review')(null, 'missing')).resolves.toBeNull();
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
