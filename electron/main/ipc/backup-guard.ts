import type { IpcMain } from 'electron';
import { beginLibraryMutation } from '../storage/backup-gate.js';
/** Default-deny writes during backup; newly introduced commands are protected. */
const reads = new Set([
  'backup:preview',
  'backup:run',
  'backup:status',
  'meetings:list',
  'meetings:list-page',
  'meetings:get-many',
  'meetings:list-ids',
  'meetings:get',
  'meetings:get-transcript',
  'meetings:get-speaker-review',
  'meetings:get-status',
  'groups:list',
  'recording:list-sources',
  'recording:state',
  'recording:active',
  'recording:meeting',
  'setup:health',
  'recovery:item',
  'recovery:preview',
  'permissions:audio-get',
  'permissions:mic-status',
  'speakers:list',
  'speakers:sample',
  'speakers:suggestions',
  'settings:get',
  'models:list',
  'onboarding:whisper-list',
  'onboarding:hf-token-status',
  'search:query',
  'search:cancel',
  'weekly:get-structured',
  'llm:detect-providers',
  'stt:probe',
  'llm:probe',
  'pipeline:status',
  'app:get-version',
  'logs:tail',
  'google:auth-status',
  'notes-history:list',
  'notes-history:compare',
  'obsidian:status',
  'obsidian:preview',
  'obsidian:compare',
  'terminology:list',
  'terminology:preview',
]);
export function guardLibraryIpc(ipc: IpcMain): IpcMain {
  return new Proxy(ipc, {
    get(target, key) {
      if (key !== 'handle') {
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return (channel: string, listener: Parameters<IpcMain['handle']>[1]): void =>
        target.handle(channel, async (event, ...args) => {
          if (reads.has(channel)) return listener(event, ...args);
          const finish = beginLibraryMutation();
          try {
            return await listener(event, ...args);
          } finally {
            finish();
          }
        });
    },
  });
}
