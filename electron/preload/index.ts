import { contextBridge, ipcRenderer } from 'electron';

// Inlined to keep the preload (CJS) and main (ESM) builds independent — sharing
// a compiled module across both modes causes the file in dist/ to flip between
// formats depending on tsc invocation order. The constants here MUST match
// electron/main/ipc/contracts.ts; a unit test enforces parity.
const IPC_CHANNELS = {
  meetingsList: 'meetings:list',
  meetingsGet: 'meetings:get',
  meetingsRename: 'meetings:rename',
  meetingsDelete: 'meetings:delete',
  meetingsUndoDelete: 'meetings:undo-delete',
  meetingsRerun: 'meetings:rerun',
  meetingsStart: 'meetings:start',
  meetingsStartMany: 'meetings:start-many',
  meetingsSetSkipSpeakerId: 'meetings:set-skip-speaker-id',
  meetingsContinueFromSpeakerId: 'meetings:continue-from-speaker-id',
  meetingsSaveSummary: 'meetings:save-summary',
  recordingListSources: 'recording:list-sources',
  recordingStart: 'recording:start',
  recordingStop: 'recording:stop',
  recordingState: 'recording:state',
  recordingLevelEvent: 'recording:level',
  recordingStateEvent: 'recording:state-change',
  permissionsAudioGet: 'permissions:audio-get',
  permissionsRequestMic: 'permissions:request-mic',
  permissionsMicStatus: 'permissions:mic-status',
  speakersList: 'speakers:list',
  speakersConfirm: 'speakers:confirm',
  speakersRename: 'speakers:rename',
  speakersSample: 'speakers:sample',
  speakersAssign: 'speakers:assign',
  speakersUnlink: 'speakers:unlink',
  actionItemsSetStatus: 'action-items:set-status',
  actionItemsUpdate: 'action-items:update',
  actionItemsDelete: 'action-items:delete',
  actionItemsCreate: 'action-items:create',
  exportRun: 'export:run',
  dialogSave: 'dialog:save',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  modelsList: 'models:list',
  meetingDetectedEvent: 'meeting-detector:detected',
  meetingDetectorDismiss: 'meeting-detector:dismiss',
  onboardingWhisperList: 'onboarding:whisper-list',
  onboardingWhisperInstall: 'onboarding:whisper-install',
  onboardingHfTokenSave: 'onboarding:hf-token-save',
  onboardingOpenExternal: 'onboarding:open-external',
  searchQuery: 'search:query',
  weeklyGet: 'weekly:get',
  weeklyRegenerate: 'weekly:regenerate',
  weeklyGetStructured: 'weekly:get-structured',
  weeklyGetNarrative: 'weekly:get-narrative',
  weeklyExportMarkdown: 'weekly:export-markdown',
  llmDetectProviders: 'llm:detect-providers',
  sttProbe: 'stt:probe',
  llmProbe: 'llm:probe',
  meetingsImportDropped: 'meetings:import-dropped',
  transcriptExport: 'transcript:export',
} as const;

const api = {
  meetings: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.meetingsList),
    get: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.meetingsGet, id),
    rename: (id: string, title: string) => ipcRenderer.invoke(IPC_CHANNELS.meetingsRename, id, title),
    /** Soft delete: moves audio files + meeting folder to the trash and
     *  stamps `deleted_at` on the DB row. The row is hidden from listings
     *  but recoverable via `undoDelete` for ~90s. After the undo window,
     *  a periodic purge job in the main process hard-deletes the files
     *  and the row. */
    delete: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.meetingsDelete, id) as Promise<void>,
    /** Restore a soft-deleted meeting. Returns true if the files were
     *  moved back and the row's deleted_at cleared; false if the undo
     *  window already expired. */
    undoDelete: (id: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.meetingsUndoDelete, id) as Promise<boolean>,
    rerun: (id: string, fromStage: string) => ipcRenderer.invoke(IPC_CHANNELS.meetingsRerun, id, fromStage),
    start: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.meetingsStart, id),
    startMany: (ids: string[]) => ipcRenderer.invoke(IPC_CHANNELS.meetingsStartMany, ids) as Promise<number>,
    // Toggles the per-meeting speaker-ID gate. When `skip` is true and the
    // meeting is currently parked at `awaiting_speaker_id`, the main process
    // also re-enqueues it so the pipeline sails past the gate immediately.
    setSkipSpeakerId: (id: string, skip: boolean) =>
      ipcRenderer.invoke(IPC_CHANNELS.meetingsSetSkipSpeakerId, id, skip),
    // Manual "I'm done identifying speakers — continue." Only valid when the
    // meeting is at `awaiting_speaker_id`; otherwise no-ops.
    continueFromSpeakerId: (id: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.meetingsContinueFromSpeakerId, id),
    // Overwrite summary.md on disk with user-edited markdown. The renderer
    // owns the editing UX; the main process just writes bytes. Returns the
    // saved markdown so the caller can confirm round-trip without needing
    // an extra meetings.get fetch.
    saveSummary: (id: string, markdown: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.meetingsSaveSummary, id, markdown) as Promise<string>,
    /** Import audio files dropped into the window. Copies them into
     *  audioWatchPath; the chokidar watcher picks them up as new
     *  pending meetings. Returns counts so the renderer can toast
     *  "Imported 3 of 5 (2 unsupported)." */
    importDropped: (paths: string[]) =>
      ipcRenderer.invoke(IPC_CHANNELS.meetingsImportDropped, paths) as Promise<{
        imported: number;
        skipped: { path: string; reason: string }[];
      }>,
    /** Save a pre-rendered transcript export. The renderer formats the
     *  content (per-line vs grouped) then hands the string off; main
     *  shows the native save dialog and writes the file. Returns the
     *  chosen path or null if the user cancelled. */
    exportTranscript: (input: {
      content: string;
      defaultName: string;
      format: 'md' | 'txt';
    }) => ipcRenderer.invoke(IPC_CHANNELS.transcriptExport, input) as Promise<{
      path: string | null;
    }>,
  },
  recording: {
    listSources: () => ipcRenderer.invoke(IPC_CHANNELS.recordingListSources),
    start: (input: { targetPid: number | 'system'; targetLabel: string; mic: boolean }) =>
      ipcRenderer.invoke(IPC_CHANNELS.recordingStart, input),
    stop: (sessionId: string) => ipcRenderer.invoke(IPC_CHANNELS.recordingStop, sessionId),
    state: (sessionId: string) => ipcRenderer.invoke(IPC_CHANNELS.recordingState, sessionId),
    onLevel: (cb: (e: { sessionId: string; peakDb: number }) => void) => {
      const wrapped = (_e: unknown, payload: { sessionId: string; peakDb: number }): void => cb(payload);
      ipcRenderer.on(IPC_CHANNELS.recordingLevelEvent, wrapped);
      return () => ipcRenderer.off(IPC_CHANNELS.recordingLevelEvent, wrapped);
    },
    onStateChange: (cb: (e: { sessionId: string; state: string }) => void) => {
      const wrapped = (_e: unknown, payload: { sessionId: string; state: string }): void => cb(payload);
      ipcRenderer.on(IPC_CHANNELS.recordingStateEvent, wrapped);
      return () => ipcRenderer.off(IPC_CHANNELS.recordingStateEvent, wrapped);
    },
  },
  speakers: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.speakersList),
    confirm: (input: { meetingId: string; localLabel: string; displayName: string; embedding: number[] }) =>
      ipcRenderer.invoke(IPC_CHANNELS.speakersConfirm, input),
    rename: (id: string, name: string) => ipcRenderer.invoke(IPC_CHANNELS.speakersRename, id, name),
    // Returns the sample clip for a diarized speaker as a data URI so the
    // renderer can play it with <audio src={dataUri}> without any custom
    // protocol / webSecurity juggling.
    sample: (meetingId: string, localLabel: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.speakersSample, meetingId, localLabel) as Promise<{
        dataUri: string;
        startS: number;
        endS: number;
      } | null>,
    // Unified assign endpoint — covers "link to an existing roster entry",
    // "create a new roster entry from this voice", and "update the display
    // name of the linked roster entry" in a single call.
    assign: (input: {
      meetingId: string;
      localLabel: string;
      mode: 'existing' | 'new';
      rosterId?: string;
      displayName?: string;
    }) => ipcRenderer.invoke(IPC_CHANNELS.speakersAssign, input) as Promise<string>,
    unlink: (meetingId: string, localLabel: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.speakersUnlink, meetingId, localLabel),
  },
  actionItems: {
    setStatus: (id: string, status: string) => ipcRenderer.invoke(IPC_CHANNELS.actionItemsSetStatus, id, status),
    /** Inline-edit a single field of an existing item (#44). Pass undefined
     *  for fields you want to leave unchanged, null to clear. */
    update: (id: string, patch: { text?: string; ownerName?: string | null; dueDate?: string | null }) =>
      ipcRenderer.invoke(IPC_CHANNELS.actionItemsUpdate, id, patch) as Promise<void>,
    /** Hard-delete a single action item. No undo (these are cheap to
     *  retype; the undo budget is spent on meeting-level delete). */
    delete: (id: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.actionItemsDelete, id) as Promise<void>,
    /** Create a single action item for the "Add item" button. */
    create: (meetingId: string, patch: { text: string; ownerName?: string | null; dueDate?: string | null }) =>
      ipcRenderer.invoke(IPC_CHANNELS.actionItemsCreate, meetingId, patch) as Promise<void>,
  },
  export: {
    // `itemIds` is optional — omitting it falls back to exporting every
    // open action item (the pre-modal behavior), so old callers still work.
    run: (exporter: string, meetingId: string, itemIds?: string[], outputPath?: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.exportRun, { exporter, meetingId, itemIds, outputPath }),
  },
  dialog: {
    // Prompts the user with a native "Save As…" sheet. Returns the chosen
    // absolute path, or null if the user cancelled.
    save: (opts: { defaultPath?: string; filters?: { name: string; extensions: string[] }[] }) =>
      ipcRenderer.invoke(IPC_CHANNELS.dialogSave, opts) as Promise<string | null>,
  },
  settings: {
    getAll: () => ipcRenderer.invoke(IPC_CHANNELS.settingsGet),
    set: (key: string, value: unknown) => ipcRenderer.invoke(IPC_CHANNELS.settingsSet, key, value),
  },
  models: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.modelsList),
  },
  meetingDetector: {
    // Push channel: main sends { platform, url, title, browserPid, browserLabel }
    // when a meeting URL is observed. Unsubscribe via the returned callback.
    onDetected: (cb: (m: {
      platform: string; url: string; title: string | null;
      browserPid: number; browserLabel: string;
    }) => void) => {
      const wrapped = (_e: unknown, payload: {
        platform: string; url: string; title: string | null;
        browserPid: number; browserLabel: string;
      }): void => cb(payload);
      ipcRenderer.on(IPC_CHANNELS.meetingDetectedEvent, wrapped);
      return () => ipcRenderer.off(IPC_CHANNELS.meetingDetectedEvent, wrapped);
    },
    dismiss: (url: string) => ipcRenderer.invoke(IPC_CHANNELS.meetingDetectorDismiss, url),
  },
  onboarding: {
    /** List currently-installed Whisper models (by inspecting
     *  whisper-server.sh's models directory). */
    listWhisperModels: () =>
      ipcRenderer.invoke(IPC_CHANNELS.onboardingWhisperList) as Promise<string[]>,
    /** Download and install a Whisper model by name (e.g. "medium.en").
     *  Resolves on completion; rejects with a readable message on failure.
     *  No progress stream yet — shows a spinner for the full ~1-3 min
     *  download depending on model + connection. */
    installWhisperModel: (model: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.onboardingWhisperInstall, model) as Promise<void>,
    /** Write an HF token to ~/.cache/huggingface/token with 0600 perms.
     *  Caller is expected to have validated it already. */
    saveHfToken: (token: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.onboardingHfTokenSave, token) as Promise<void>,
    /** Open an external URL (HF model-gate pages, LM Studio download,
     *  System Settings deep-links) via shell.openExternal. */
    openExternal: (url: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.onboardingOpenExternal, url) as Promise<void>,
  },
  search: {
    /** Full-text search across meeting titles + summaries + transcripts.
     *  Returns at most `limit` results, sorted title > summary >
     *  transcript. Each result carries the meeting id, the matched
     *  snippet, and a `seconds` offset when the hit was on a specific
     *  transcript line (so callers can jump to the timestamp). */
    query: (q: string, limit?: number) =>
      ipcRenderer.invoke(IPC_CHANNELS.searchQuery, q, limit ?? 20) as Promise<{
        meetingId: string;
        title: string;
        source: 'title' | 'summary' | 'transcript';
        snippet: string;
        /** For transcript hits, the timestamp seconds so the detail view
         *  can seek right to the matched line. */
        seconds?: number;
      }[]>,
  },
  weekly: {
    /** Fetch the full data needed to render the weekly view in a
     *  single call. The first call for a given week (or any call
     *  after the input meetings change) blocks while the LLM
     *  regenerates the narrative; subsequent calls return cached
     *  data instantly. Prefer the {getStructured, getNarrative}
     *  pair for new code so the renderer can paint the structured
     *  sections immediately and stream the narrative card in. */
    get: (year: number, week: number) =>
      ipcRenderer.invoke(IPC_CHANNELS.weeklyGet, year, week) as Promise<unknown>,
    /** Fast path: structured data only (meetings + action items +
     *  range info). No LLM call — returns within tens of ms. Used
     *  by the WeeklyView to paint the page before the narrative
     *  finishes drafting. */
    getStructured: (year: number, week: number) =>
      ipcRenderer.invoke(IPC_CHANNELS.weeklyGetStructured, year, week) as Promise<unknown>,
    /** Slow path: returns the cached narrative if the input hash
     *  matches, otherwise triggers an LLM call (10–60 s typical).
     *  Pass force=true to bypass the cache (used by the Regenerate
     *  button). */
    getNarrative: (year: number, week: number, force = false) =>
      ipcRenderer.invoke(IPC_CHANNELS.weeklyGetNarrative, year, week, force) as Promise<unknown>,
    /** Force-clear the cache and regenerate the LLM narrative.
     *  Equivalent to getNarrative(year, week, true). Kept for the
     *  legacy callers that still use the single-call IPC. */
    regenerate: (year: number, week: number) =>
      ipcRenderer.invoke(IPC_CHANNELS.weeklyRegenerate, year, week) as Promise<unknown>,
    /** Save the rendered Markdown to disk via a Save dialog.
     *  Returns { path: null, markdown } when the user cancels;
     *  the markdown is still useful for clipboard fallbacks. */
    exportMarkdown: (year: number, week: number) =>
      ipcRenderer.invoke(IPC_CHANNELS.weeklyExportMarkdown, year, week) as Promise<{
        path: string | null;
        markdown: string;
      }>,
  },
  llm: {
    /** Probe whether `lms` and `ollama` CLIs are installed and
     *  whether their default ports already have something listening.
     *  Used by the Settings UI to dim unavailable provider options. */
    detectProviders: () =>
      ipcRenderer.invoke(IPC_CHANNELS.llmDetectProviders) as Promise<{
        lmStudio: { binary: boolean; running: boolean };
        ollama: { binary: boolean; running: boolean };
      }>,
    /** Probe a chat-completions endpoint. Returns ok with the loaded
     *  model ids, or err with a human-readable message. */
    probe: (url: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.llmProbe, url) as Promise<
        | { ok: true; models: string[] }
        | { ok: false; error: string }
      >,
  },
  stt: {
    /** Probe a whisper-server endpoint by parsing /health JSON. */
    probe: (url: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.sttProbe, url) as Promise<
        | { ok: true }
        | { ok: false; error: string }
      >,
  },
  permissions: {
    audio: () => ipcRenderer.invoke(IPC_CHANNELS.permissionsAudioGet) as Promise<{
      mic: 'granted' | 'denied' | 'not-determined' | 'unknown';
      audioCapture: 'granted' | 'denied' | 'not-determined' | 'unknown';
    }>,
    requestMic: () => ipcRenderer.invoke(IPC_CHANNELS.permissionsRequestMic) as Promise<boolean>,
    micStatus: () => ipcRenderer.invoke(IPC_CHANNELS.permissionsMicStatus) as Promise<'granted' | 'denied' | 'not-determined' | 'unknown'>,
  },
  on: (channel: string, handler: (...args: unknown[]) => void) => {
    const wrapped = (_e: unknown, ...args: unknown[]) => handler(...args);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.off(channel, wrapped);
  },
  /** Subscribe to custom application-menu actions. The main process
   *  emits action names like 'toggle-record', 'view-library',
   *  'open-search', etc. on the 'mn:menu-action' channel. Returns
   *  an unsubscribe callback. */
  onMenuAction: (cb: (action: string) => void) => {
    const wrapped = (_e: unknown, action: string): void => cb(action);
    ipcRenderer.on('mn:menu-action', wrapped);
    return () => ipcRenderer.off('mn:menu-action', wrapped);
  },
};

contextBridge.exposeInMainWorld('api', api);
export type MeetingNotesApi = typeof api;
