import { contextBridge, ipcRenderer } from 'electron';
import type { SpeechBetaBridge } from '../shared/speech-beta.js';

const bridge: SpeechBetaBridge = {
  status: () => ipcRenderer.invoke('speech-beta', { operation: 'status' }),
  previewImport: () => ipcRenderer.invoke('speech-beta', { operation: 'preview-import' }),
  importLibrary: () => ipcRenderer.invoke('speech-beta', { operation: 'import' }),
  prepare: provider => ipcRenderer.invoke('speech-beta', { operation: 'prepare', provider }),
  compare: id => ipcRenderer.invoke('speech-beta', { operation: 'compare', id }),
  run: (id, mode) => ipcRenderer.invoke('speech-beta', { operation: 'run', id, mode }),
  cancel: () => ipcRenderer.invoke('speech-beta', { operation: 'cancel' }),
  confirm: (id, label, rosterId) => ipcRenderer.invoke('speech-beta', { operation: 'confirm', id, label, rosterId }),
};
contextBridge.exposeInMainWorld('speechBeta', bridge);
