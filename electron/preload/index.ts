import { contextBridge, ipcRenderer } from 'electron';

// Inlined to keep the preload (CJS) and main (ESM) builds independent — sharing
// a compiled module across both modes causes the file in dist/ to flip between
// formats depending on tsc invocation order. The constants here MUST match
// electron/main/ipc/contracts.ts; a unit test enforces parity.
const IPC_CHANNELS = {
  meetingsList: 'meetings:list',
  meetingsGet: 'meetings:get',
  meetingsRename: 'meetings:rename',
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
  exportRun: 'export:run',
  dialogSave: 'dialog:save',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  modelsList: 'models:list',
} as const;

const api = {
  meetings: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.meetingsList),
    get: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.meetingsGet, id),
    rename: (id: string, title: string) => ipcRenderer.invoke(IPC_CHANNELS.meetingsRename, id, title),
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
};

contextBridge.exposeInMainWorld('api', api);
export type MeetingNotesApi = typeof api;
