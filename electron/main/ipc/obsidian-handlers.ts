import { dialog, shell, type IpcMain } from 'electron';
import { z } from 'zod';
import { IPC_CHANNELS } from './contracts.js';
import type { ObsidianSync } from '../obsidian/service.js';

export function registerObsidianHandlers(ipc: IpcMain, sync: ObsidianSync): void {
  ipc.handle(IPC_CHANNELS.obsidianStatus, () => sync.status());
  ipc.handle(IPC_CHANNELS.obsidianChoose, async () => {
    const r = await dialog.showOpenDialog({
      title: 'Choose your Obsidian vault',
      properties: ['openDirectory'],
    });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });
  ipc.handle(IPC_CHANNELS.obsidianPreview, (_e, input: unknown) => sync.preview(input));
  ipc.handle(IPC_CHANNELS.obsidianEnable, (_e, token: unknown) =>
    sync.enable(z.string().uuid().parse(token)),
  );
  ipc.handle(IPC_CHANNELS.obsidianDisable, () => sync.disable());
  ipc.handle(IPC_CHANNELS.obsidianRetry, () => {
    sync.retry();
    return sync.status();
  });
  ipc.handle(IPC_CHANNELS.obsidianOpen, async () => {
    const error = await shell.openPath(sync.folder());
    if (error) throw new Error(error);
  });
  ipc.handle(IPC_CHANNELS.obsidianCompare, (_e, id: unknown) =>
    sync.compare(z.string().min(1).max(200).parse(id)),
  );
  ipc.handle(IPC_CHANNELS.obsidianReplace, (_e, id: unknown, revision: unknown) =>
    sync.replace(z.string().min(1).max(200).parse(id), z.string().length(64).parse(revision)),
  );
  ipc.handle(IPC_CHANNELS.obsidianRepair, () => sync.recreateViews());
  ipc.handle(IPC_CHANNELS.obsidianExportComparison, async (_e, id: unknown) => {
    const { proposed } = sync.compare(z.string().min(1).max(200).parse(id));
    const r = await dialog.showSaveDialog({
      title: 'Save latest MeetingNotes version for comparison',
      defaultPath: 'meeting-latest.md',
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    if (r.canceled || !r.filePath) return;
    // Save dialog grants this explicit export path, independently of automatic sync.
    const fs = await import('node:fs/promises');
    await fs.writeFile(r.filePath, proposed, { flag: 'wx' });
  });
}
