import type { IpcMain } from 'electron';
import { z } from 'zod';
import { IPC_CHANNELS } from './contracts.js';
import type { IpcServices } from './handlers.js';
import { extractActionItemsFromSummary } from '../pipeline/extract-action-items.js';
import { ActionFilterSchema } from '../../shared/productivity.js';
import { meetingFolderPath } from '../storage/meeting-folder.js';
import { validCalendarDate } from '../../shared/calendar-date.js';

export function registerActionsListHandler(ipc: IpcMain, s: IpcServices): void {
  ipc.handle(IPC_CHANNELS.actionsList, (_e, input: unknown) => {
    const id = s.settings.get('userSpeakerId');
    return s.actionItems.live(ActionFilterSchema.parse(input), { id, name: id ? s.speakers.findById(id)?.displayName ?? null : s.settings.get('userName') || null });
  });
}

export function registerActionItemHandlers(ipc: IpcMain, s: IpcServices): void {
  const beforeActionMutation=(id:string):void=>{
    const item=s.actionItems.findById(id);if(!item)throw new Error('Action item no longer exists. Refresh this meeting.');
    const meeting=s.meetings.findById(item.meetingId);if(!meeting||meeting.deletedAt||meeting.status==='processing')throw new Error('Wait for processing to finish before editing tasks.');
    s.notesHistory?.capture(item.meetingId,'Before action item changed');
  };
  ipc.handle(IPC_CHANNELS.actionItemsSetStatus, (_e, id: unknown, status: unknown) => {
    if (typeof id !== 'string' || id.length === 0) throw new Error('invalid args');
    if (status !== 'open' && status !== 'done') throw new Error('invalid status');
    beforeActionMutation(id);
    return s.actionItems.setStatus(id, status);
  });

  // Inline edit / create / delete for action items (#44).
  ipc.handle(IPC_CHANNELS.actionItemsUpdate, (_e, id: unknown, patch: unknown) => {
    if (typeof id !== 'string' || !patch || typeof patch !== 'object') throw new Error('invalid args');
    const { text, ownerName, dueDate } = patch as { text?: unknown; ownerName?: unknown; dueDate?: unknown };
    const normalized: { text?: string; ownerName?: string | null; dueDate?: string | null } = {};
    if (text !== undefined) {
      if (typeof text !== 'string' || text.trim() === '') throw new Error('text must be a non-empty string');
      normalized.text = text.trim().slice(0, 2000);
    }
    if (ownerName !== undefined) {
      if (ownerName !== null && typeof ownerName !== 'string') throw new Error('ownerName must be string or null');
      normalized.ownerName = ownerName === null ? null : (ownerName as string).trim().slice(0, 200) || null;
    }
    if (dueDate !== undefined) {
      if (dueDate !== null && typeof dueDate !== 'string') throw new Error('dueDate must be string or null');
      if(typeof dueDate==='string'&&dueDate&&!validCalendarDate(dueDate))throw new Error('dueDate must be a valid YYYY-MM-DD date');
      normalized.dueDate = dueDate === null || dueDate === '' ? null : dueDate as string;
    }
    beforeActionMutation(id);
    s.actionItems.update(id, normalized);
  });

  ipc.handle(IPC_CHANNELS.actionItemsDelete, (_e, id: unknown) => {
    if (typeof id !== 'string' || id.length === 0) throw new Error('invalid args');
    beforeActionMutation(id);
    return s.actionItems.deleteWithUndo(id);
  });
  ipc.handle(IPC_CHANNELS.actionItemsUndoDelete,(_e,token:unknown)=>s.actionItems.undoDelete(z.string().min(1).max(100).parse(token)));

  ipc.handle(IPC_CHANNELS.actionItemsCreate, (_e, meetingId: unknown, patch: unknown) => {
    if (typeof meetingId !== 'string' || !patch || typeof patch !== 'object') throw new Error('invalid args');
    const { text, ownerName, dueDate } = patch as { text?: unknown; ownerName?: unknown; dueDate?: unknown };
    if (typeof text !== 'string' || text.trim() === '') throw new Error('text required');
    if(dueDate!==undefined&&dueDate!==null&&(typeof dueDate!=='string'||dueDate&&!validCalendarDate(dueDate)))throw new Error('dueDate must be a valid YYYY-MM-DD date');
    const meeting=s.meetings.findById(meetingId);if(!meeting||meeting.deletedAt||meeting.status==='processing')throw new Error('Wait for processing to finish before adding tasks.');
    s.notesHistory?.capture(meetingId,'Before action item added');
    s.actionItems.create(meetingId, {
      text: text.trim().slice(0, 2000),
      ownerName: typeof ownerName === 'string' && ownerName.trim() ? ownerName.trim().slice(0, 200) : null,
      dueDate: typeof dueDate === 'string' && dueDate ? dueDate : null,
    });
  });

  ipc.handle(IPC_CHANNELS.actionItemsReextract, async (_e, meetingId: unknown) => {
    if (typeof meetingId !== 'string' || meetingId.length === 0) throw new Error('invalid args');
    const meeting = s.meetings.findById(meetingId);
    if (!meeting) throw new Error('meeting not found');
    if (meeting.deletedAt || meeting.status === 'processing') throw new Error('Wait for processing to finish before re-extracting');
    const revision = s.notesHistory?.revision(meetingId);
    // Re-run ONLY the extract step against the current on-disk summary.md,
    // via the same shared helper the pipeline's extract stage uses.
    // Deliberately state-neutral: we never touch pipelineStage/status, so a
    // 'done' meeting stays 'done' and can't be dragged back into the queue.
    const folder = meetingFolderPath(s.libraryRoot, meeting.slug);
    const { count } = await extractActionItemsFromSummary(
      { ...s, onResample: (retry, words) =>
        s.logger.warn('reextract:reasoning-retry', { meetingId, retry, reasoningWords: words }),
        onZeroItemsRetry: () => s.logger.warn('reextract:zero-items-retry', { meetingId }),
        beforeReplace: () => {
          const current = s.meetings.findById(meetingId);
          if (!current || current.deletedAt || current.status === 'processing' || (revision && revision !== s.notesHistory?.revision(meetingId)))
            throw new Error('Meeting changed during extraction. Retry to use the latest notes and action items.');
          s.notesHistory?.capture(meetingId, 'Before action items replaced');
        } },
      meetingId,
      folder,
      'save a summary (with an Action Items section) before re-extracting.',
    );
    s.logger.info('action-items:reextract', { meetingId, items: count });
    return { count };
  });
}
