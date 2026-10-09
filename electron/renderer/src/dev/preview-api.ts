// Browser-preview stand-in for the Electron preload (`window.api`).
//
// Under plain `vite` there is no preload, so every IPC call would throw and
// unmount the tree. This installs an inert API so the UI can be inspected in
// a regular browser. It is imported only when `import.meta.env.DEV` is true
// and `window.api` is absent (see main.tsx), so it never ships in a build and
// never runs inside Electron.
//
// Anything not listed in `overrides` is answered by a Proxy: `on…` methods
// return an unsubscribe function and everything else resolves to undefined.
// A method added to the preload therefore cannot crash the preview; add an
// override only when a screen needs realistic data to render (#251).

import type { MeetingNotesApi } from '../../../preload';
import type { Settings } from '../../../main/storage/settings-repo';

type Fn = (...args: never[]) => unknown;

/** Override names are checked against the real API so a rename or removal in
 *  the preload fails typecheck here. Return shapes are deliberately loose. */
export type PreviewOverrides = {
  [K in keyof MeetingNotesApi]?: MeetingNotesApi[K] extends Fn
    ? Fn
    : { [M in keyof MeetingNotesApi[K]]?: Fn };
};

const unsubscribe = (): void => {};
const resolved = async (): Promise<void> => {};

const sampleMeetings = [
  { id: 'p1', slug: 'p1', title: 'recording-20260421-143000-abc123', startedAt: '2026-04-21T14:30:00', durationS: 1800, pipelineStage: 'discovered', status: 'pending', stageStartedAt: null, skipSpeakerId: false, unidentifiedCount: 0, actionItemsCount: 0, speakers: [] },
  { id: 'p2', slug: 'p2', title: 'recording-20260421-150500-def456', startedAt: '2026-04-21T15:05:00', durationS: 2700, pipelineStage: 'discovered', status: 'pending', stageStartedAt: null, skipSpeakerId: false, unidentifiedCount: 0, actionItemsCount: 0, speakers: [] },
  { id: 'b', slug: 'b', title: 'Design critique — detail view', startedAt: '2026-04-20T11:00:00', durationS: 2100, pipelineStage: 'awaiting_speaker_id', status: 'awaiting_user', stageStartedAt: null, skipSpeakerId: false, unidentifiedCount: 2, actionItemsCount: 0, speakers: [] },
  { id: 'live', slug: 'live', title: 'Sync with design', startedAt: '2026-04-20T09:00:00', durationS: 600, pipelineStage: 'diarizing', status: 'processing', stageStartedAt: new Date(Date.now() - 90000).toISOString(), skipSpeakerId: false, unidentifiedCount: 0, actionItemsCount: 0, speakers: [] },
  { id: 'c', slug: 'c', title: 'Whisper misfire', startedAt: '2026-04-20T14:00:00', durationS: 400, pipelineStage: 'transcribing', status: 'failed', stageStartedAt: null, skipSpeakerId: false, unidentifiedCount: 0, actionItemsCount: 0, speakers: [] },
  { id: 'a', slug: 'a', title: 'Quarterly planning review', startedAt: '2026-04-20T08:00:00', durationS: 3200, pipelineStage: 'done', status: 'done', stageStartedAt: null, skipSpeakerId: false, unidentifiedCount: 0, actionItemsCount: 9, speakers: [{ localLabel: 'A', rosterId: 'r', displayName: 'Alice', confidence: 0.95 }, { localLabel: 'B', rosterId: 'r', displayName: 'Bob', confidence: 0.95 }] },
  { id: 'd', slug: 'd', title: 'Standup notes', startedAt: '2026-04-19T09:00:00', durationS: 900, pipelineStage: 'done', status: 'done', stageStartedAt: null, skipSpeakerId: false, unidentifiedCount: 0, actionItemsCount: 3, speakers: [{ localLabel: 'A', rosterId: 'r', displayName: 'Alice', confidence: 0.95 }] },
];

// Typed as the full Settings record so adding a setting in main fails
// typecheck here until the preview has a value for it.
const previewSettings: Settings = {
  obsidian: null,
  lmStudioUrl: 'http://localhost:1234',
  sttUrl: 'http://127.0.0.1:8080',
  sttModel: 'whisper-1',
  llmModel: 'qwen/qwen3.5-9b',
  audioHijackSessionName: 'Meeting',
  libraryPath: '~/Documents/MeetingNotes',
  audioWatchPath: '',
  sttLanguage: 'en',
  exporterApple: true,
  exporterMarkdown: true,
  exporterWebhook: false,
  webhookUrl: '',
  webhookSecret: '',
  webhookTemplate: 'compact',
  webhookOwnerFilter: 'mine',
  webhookLastResult: null,
  recordingBitrateKbps: 128,
  autoDetectMeetings: { browserTabs: false, nativeApps: false, silenceMs: 5000 },
  autoRecordZoom: false,
  autoProcessRecordings: false,
  userName: '',
  onboardedAt: '2026-01-01T00:00:00Z',
  userSpeakerId: null,
  summaryProvider: 'external',
  llmContextLength: 0,
  summaryDetail: 'detailed',
  disableThinking: true,
  modelHealthChecks: {},
  theme: 'system',
  googleClientId: '',
  googleClientSecret: '',
  googleAccountEmail: null,
  googleRefreshTokenEnc: null,
  windowBounds: null,
};

const rows = sampleMeetings.map((m) => ({ ...m, groupId: null, groupName: null, stageEtaMs: null, stageEtaRough: false }));
type Row = typeof rows[number];

const inFilter = (m: Row, filter: string): boolean =>
  filter === 'all' ? true
  : filter === 'processing' ? m.status === 'processing' || m.status === 'awaiting_user'
  : m.status === filter;

const counts = {
  all: rows.length,
  pending: rows.filter((m) => inFilter(m, 'pending')).length,
  processing: rows.filter((m) => inFilter(m, 'processing')).length,
  done: rows.filter((m) => inFilter(m, 'done')).length,
  failed: rows.filter((m) => inFilter(m, 'failed')).length,
};

export const overrides: PreviewOverrides = {
  meetings: {
    list: async () => rows,
    listPage: async (...args: unknown[]) => {
      const query = (args as [{ filter?: string; groupId?: string | null }])[0] ?? {};
      // Sample meetings are all ungrouped; a named group is empty.
      const items = typeof query.groupId === 'string' ? [] : rows.filter((m) => inFilter(m, query.filter ?? 'all'));
      return { items, nextCursor: null, total: items.length, counts };
    },
    getMany: async (...args: unknown[]) => {
      const ids = (args as [string[]])[0] ?? [];
      return rows.filter((m) => ids.includes(m.id));
    },
    listIds: async (...args: unknown[]) => {
      const filter = (args as [string])[0] ?? 'all';
      return rows.filter((m) => inFilter(m, filter)).map((m) => m.id);
    },
    startManyDetailed: async () => ({ startedIds: [], failedIds: [] }),
    get: async () => null,
    undoDelete: async () => false,
    startMany: async () => 0,
    saveSummary: async () => '',
    importDropped: async () => ({ imported: 0, skipped: [] }),
    exportTranscript: async () => ({ path: null }),
  },
  recording: {
    listSources: async () => [],
    start: async () => ({ sessionId: 'dev' }),
    state: async () => 'idle',
    active: async () => null,
  },
  speakers: {
    list: async () => [],
    confirm: async () => '',
    sample: async () => null,
  },
  onboarding: { listWhisperModels: async () => [] },
  search: { query: async () => [], run: async () => ({ hits: [], status: 'complete' }) },
  groups: { list: async () => ({ groups: [], allCount: rows.length, ungroupedCount: rows.length }) },
  trash: { list: async () => [] },
  terminology: { list: async () => [], offers: async () => true },
  obsidian: { status: async () => ({ config: null, running: false, lastSuccess: null, error: null, pending: 0, synced: 0, issues: [] }) },
  backup: { preview: async () => null },
  recovery: { list: async () => [] },
  export: { run: async () => ({}) },
  dialog: { save: async () => null },
  settings: {
    // onboardedAt truthy so the preview opens straight to Library. To preview
    // the setup wizard instead, change it to `null`.
    getAll: async () => previewSettings,
  },
  models: { list: async () => [] },
  permissions: {
    audio: async () => ({ mic: 'granted', audioCapture: 'granted' }),
    requestMic: async () => true,
    micStatus: async () => 'granted',
    setupHealth: async () => [],
  },
  pipeline: {
    status: async () => ({ paused: false, currentId: null, queueLength: 0, queueIds: [] }),
    clear: async () => ({ cleared: [] }),
  },
  llm: {
    detectProviders: async () => ({ lmStudio: { binary: false, running: false }, ollama: { binary: false, running: false } }),
    probe: async () => ({ ok: true, models: [] }),
  },
  stt: { probe: async () => ({ ok: true }) },
  weekly: {
    get: async () => ({}),
    getStructured: async () => ({
      isoYear: 2026, isoWeek: 17, rangeStart: '', rangeEnd: '', totalDurationS: 0, meetings: [],
      openActionGroups: [], openActionCount: 0, inProgress: false, hasFreshCache: false,
    }),
    getNarrative: async () => ({ narrative: '', decisions: [], generatedAt: '', fromCache: false }),
    regenerate: async () => ({}),
    exportMarkdown: async () => ({ path: null, markdown: '' }),
  },
  app: { getVersion: async () => '0.0.0-dev' },
  google: {
    authStart: async () => ({ email: null }),
    authStatus: async () => ({ email: null, hasCredentials: false, signedIn: false }),
  },
  logs: { tail: async () => ({ path: '', entries: [] }) },
  webhook: { testSend: async () => ({ ts: new Date().toISOString(), status: null, error: 'dev-shim' }) },
};

function inert(name: string): Fn {
  return /^on([A-Z]|$)/.test(name) ? () => unsubscribe : resolved;
}

/** Looks up `key` on `known`, falling back to an inert function. Results are
 *  cached so repeated reads return the same reference (hook dependencies). */
function withDefaults(known: Record<string, unknown>, base: object, deep: boolean): unknown {
  const cache = new Map<string, unknown>();
  return new Proxy(base, {
    get(_target, key) {
      // Symbols and `then` must stay undefined or the proxy looks like a
      // thenable/iterable to React and to `await`.
      if (typeof key !== 'string' || key === 'then') return undefined;
      if (cache.has(key)) return cache.get(key);
      const value = known[key];
      const result = typeof value === 'function' ? value
        : value && typeof value === 'object' ? withDefaults(value as Record<string, unknown>, {}, false)
        // Unknown top-level key: callable (like `api.onMenuAction`) and also
        // usable as a namespace (like `api.newThing.method()`).
        : deep ? withDefaults({}, inert(key), false)
        : inert(key);
      cache.set(key, result);
      return result;
    },
    has: () => true,
  });
}

export function createPreviewApi(): MeetingNotesApi {
  return withDefaults(overrides as Record<string, unknown>, {}, true) as MeetingNotesApi;
}

export function installPreviewApi(): void {
  window.api = createPreviewApi();
}
