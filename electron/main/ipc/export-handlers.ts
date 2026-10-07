import type { IpcMain } from 'electron';
import { BrowserWindow, dialog } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { IPC_CHANNELS } from './contracts.js';
import type { IpcServices } from './handlers.js';
import { meetingFolderPath } from '../storage/meeting-folder.js';
import { isMyItem, userIsIdentified } from '../exporters/owner-filter.js';
import { exportTarget } from './export-targets.js';

export function registerExportHandlers(ipc: IpcMain, s: IpcServices): void {
  ipc.handle(IPC_CHANNELS.exportRun, async (_e, input: {
    exporter: string;
    meetingId: string;
    itemIds?: string[]; // optional subset; omitted = all open items (legacy behavior)
    outputPath?: string; // optional file path for file-based exporters
  }) => {
    if (typeof input?.exporter !== 'string' || typeof input?.meetingId !== 'string') throw new Error('invalid args');
    const meeting = s.meetings.findById(input.meetingId);
    if (!meeting) throw new Error('meeting not found');
    const folder = meetingFolderPath(s.libraryRoot, meeting.slug);
    const exporter = s.exporters[input.exporter];
    if (!exporter) throw new Error(`unknown exporter: ${input.exporter}`);
    const target = exportTarget(input.exporter);
    if (!target) throw new Error(`unknown exporter metadata: ${input.exporter}`);
    const rows = s.actionItems.listByMeeting(input.meetingId);
    let selectedRows = Array.isArray(input.itemIds)
      ? rows.filter((r) => input.itemIds!.includes(r.id))
      : rows;
    // Task-app exporters (Reminders, Google Tasks) push into the user's
    // personal to-do list, so they ONLY ever send items assigned to the
    // user — never the whole meeting's action items. Enforced here as
    // defense-in-depth even though the renderer also pre-filters the modal.
    if (target.ownOpenItemsOnly) {
      const userSpeakerId = s.settings.get('userSpeakerId');
      const me = {
        userSpeakerId,
        userDisplayName: userSpeakerId
          ? (s.speakers.list().find((sp) => sp.id === userSpeakerId)?.displayName ?? null)
          : null,
      };
      if (!userIsIdentified(me)) {
        throw new Error('Set who you are in Settings → "You are…" to export your action items.');
      }
      selectedRows = selectedRows.filter((r) => r.status !== 'done' && isMyItem(r, me));
      if (selectedRows.length === 0) {
        throw new Error("None of this meeting's open action items are assigned to you.");
      }
    }
    const items = selectedRows.map((ai) => ({
      id: ai.id, text: ai.text, ownerName: ai.ownerName, dueDate: ai.dueDate, status: ai.status,
    }));
    const summaryPath = path.join(folder, 'summary.md');
    const summaryMd = fs.existsSync(summaryPath) ? fs.readFileSync(summaryPath, 'utf8') : null;
    // Document exporters render the summary + a
    // checklist, so they're valid with zero items. Task/integration
    // exporters only push action items, so an empty set there is a no-op.
    if (items.length === 0 && !target.allowsEmptySelection) {
      throw new Error('No action items selected');
    }
    if (items.length === 0 && !summaryMd) {
      throw new Error('Nothing to export — this meeting has no summary or action items yet.');
    }
    const result = await exporter.export({
      items, meetingTitle: meeting.title, meetingFolder: folder,
      summaryMd,
      outputPath: typeof input.outputPath === 'string' ? input.outputPath : undefined,
      onItemExported: (id) => s.actionItems.markExported(id, input.exporter),
    });
    return result;
  });

  ipc.handle(IPC_CHANNELS.dialogSave, async (_e, opts: unknown) => {
    // Thin wrapper over Electron's save dialog so the renderer can prompt
    // the user for a destination before a file-based export runs. We
    // intentionally don't write the file here — the exporter does, using
    // the returned path — so dialog:save stays a pure user-intent query.
    const parsed = (opts ?? {}) as { defaultPath?: unknown; filters?: unknown };
    const defaultPath = typeof parsed.defaultPath === 'string' ? parsed.defaultPath : undefined;
    const filters = Array.isArray(parsed.filters)
      ? (parsed.filters as { name: string; extensions: string[] }[])
      : undefined;
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const result = win
      ? await dialog.showSaveDialog(win, { defaultPath, filters })
      : await dialog.showSaveDialog({ defaultPath, filters });
    if (result.canceled || !result.filePath) return null;
    return result.filePath;
  });
}
