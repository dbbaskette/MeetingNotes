import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS } from '../main/ipc/contracts';

const api = {
  meetings: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.meetingsList),
    get: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.meetingsGet, id),
    rename: (id: string, title: string) => ipcRenderer.invoke(IPC_CHANNELS.meetingsRename, id, title),
    rerun: (id: string, fromStage: string) => ipcRenderer.invoke(IPC_CHANNELS.meetingsRerun, id, fromStage),
  },
  record: {
    start: (sessionName: string) => ipcRenderer.invoke(IPC_CHANNELS.recordStart, sessionName),
    stop: (sessionName: string) => ipcRenderer.invoke(IPC_CHANNELS.recordStop, sessionName),
    state: (sessionName: string) => ipcRenderer.invoke(IPC_CHANNELS.recordState, sessionName),
  },
  speakers: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.speakersList),
    confirm: (input: { meetingId: string; localLabel: string; displayName: string; embedding: number[] }) =>
      ipcRenderer.invoke(IPC_CHANNELS.speakersConfirm, input),
    rename: (id: string, name: string) => ipcRenderer.invoke(IPC_CHANNELS.speakersRename, id, name),
  },
  actionItems: {
    setStatus: (id: string, status: string) => ipcRenderer.invoke(IPC_CHANNELS.actionItemsSetStatus, id, status),
  },
  export: {
    run: (exporter: string, meetingId: string) => ipcRenderer.invoke(IPC_CHANNELS.exportRun, { exporter, meetingId }),
  },
  settings: {
    getAll: () => ipcRenderer.invoke(IPC_CHANNELS.settingsGet),
    set: (key: string, value: unknown) => ipcRenderer.invoke(IPC_CHANNELS.settingsSet, key, value),
  },
  models: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.modelsList),
  },
  on: (channel: string, handler: (...args: unknown[]) => void) => {
    const wrapped = (_e: unknown, ...args: unknown[]) => handler(...args);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.off(channel, wrapped);
  },
};

contextBridge.exposeInMainWorld('api', api);
export type MeetingNotesApi = typeof api;
