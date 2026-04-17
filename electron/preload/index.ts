import { contextBridge } from 'electron';

// Placeholder — real API exposed in Phase 10 (IPC).
contextBridge.exposeInMainWorld('api', { ping: () => 'pong' });
