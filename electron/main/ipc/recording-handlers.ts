import type { IpcMain } from 'electron';
import { z } from 'zod';
import { IPC_CHANNELS, OptionalGroupScopeSchema } from './contracts.js';
import type { IpcServices } from './handlers.js';
import { testCapture } from '../recording/capture-test.js';
import { setupHealth } from './setup-health.js';
import { probeAudioPermissions, requestMicAccess, getMicAccessStatus } from '../permissions/audio.js';

export function registerRecordingMeetingHandler(ipc: IpcMain, s: IpcServices): void {
  ipc.handle(IPC_CHANNELS.recordingMeeting,async(_event,sessionId:unknown)=>{
    const output=s.recordingManager.recordedOutput(z.string().min(1).max(100).parse(sessionId));if(!output)return null;
    for(let attempt=0;attempt<50;attempt++){const meeting=s.meetings.findByAudioPath(output);if(meeting)return {id:meeting.id,title:meeting.title};await new Promise(resolve=>setTimeout(resolve,100));}return null;
  });
}

export function registerRecordingHandlers(ipc: IpcMain, s: IpcServices): void {
  // Built-in recording namespace. The renderer asks for a list of audible
  // apps, picks one, and the manager spawns the bundled meeting-notes-tap
  // helper. Level + state-change events are broadcast via webContents.send
  // (wired up where the manager is constructed in electron/main/index.ts).
  ipc.handle(IPC_CHANNELS.recordingListSources, async () => s.appEnumerator.list());
  ipc.handle(IPC_CHANNELS.recordingActive, () => s.recordingManager.active());
  ipc.handle(IPC_CHANNELS.setupHealth, () => setupHealth(s));
  ipc.handle(IPC_CHANNELS.recordingTest, async (_e, input: unknown) => {
    const parsed = z.object({ targetPid: z.union([z.literal('system'), z.number().int().positive()]),
      targetLabel: z.string().min(1).max(200), mic: z.boolean() }).strict().parse(input);
    return testCapture(s.recordingManager, parsed);
  });
  ipc.handle(IPC_CHANNELS.recordingStart, async (_e, input: unknown) => {
    if (typeof input !== 'object' || input === null) throw new Error('invalid args');
    const { targetPid, targetLabel, mic, groupId, title } = z.object({
      targetPid: z.union([z.literal('system'), z.number().int().positive()]),
      targetLabel: z.string().min(1).max(200), mic: z.boolean(), groupId: OptionalGroupScopeSchema,
      title: z.string().max(200).optional(),
    }).parse(input);
    // A group may have been deleted while the picker was open. Capture is
    // more important than filing; keep the one-click start and ungroup it.
    const validGroupId = groupId && s.groups.exists(groupId) ? groupId : null;
    return s.recordingManager.start({ targetPid, targetLabel, mic, groupId: validGroupId, title });
  });
  ipc.handle(IPC_CHANNELS.recordingStop, async (_e, sessionId: unknown) => {
    if (typeof sessionId !== 'string') throw new Error('sessionId required');
    return s.recordingManager.stop(sessionId);
  });
  ipc.handle(IPC_CHANNELS.recordingState, (_e, sessionId: unknown) => {
    if (typeof sessionId !== 'string') throw new Error('sessionId required');
    return s.recordingManager.state(sessionId);
  });
  // Silence prompt (#305). The prompt and its clearing are broadcast from
  // index.ts; these answer it and let a late window catch up.
  ipc.handle(IPC_CHANNELS.recordingContinueSilence, (_e, sessionId: unknown) => {
    if (typeof sessionId !== 'string') throw new Error('sessionId required');
    s.recordingManager.continueSilence(sessionId);
  });
  ipc.handle(IPC_CHANNELS.recordingSilenceState, () => s.recordingManager.silenceState());

  ipc.handle(IPC_CHANNELS.recoveryList, (event, requestId: unknown) => {
    if (requestId !== undefined && (typeof requestId !== 'string' || requestId.length > 100)) {
      throw new Error('invalid recovery request id');
    }
    return s.recordingRecovery.list(typeof requestId === 'string' ? (item, index) => {
      if (!event.sender.isDestroyed()) event.sender.send(IPC_CHANNELS.recoveryItem, { requestId, item, index });
    } : undefined);
  });
  ipc.handle(IPC_CHANNELS.recoveryRecover, (_e, id: unknown) => {
    if (typeof id !== 'string' || !id) throw new Error('recovery id required');
    return s.recordingRecovery.recover(id);
  });
  ipc.handle(IPC_CHANNELS.recoveryTrim, (_e, input: unknown) => {
    if (!input || typeof input !== 'object') throw new Error('invalid recovery trim');
    const { id, endSeconds, startSeconds = 0 } = input as { id?: unknown; endSeconds?: unknown; startSeconds?: unknown };
    if (typeof id !== 'string' || !id || typeof endSeconds !== 'number' || typeof startSeconds !== 'number') throw new Error('invalid recovery trim');
    return s.recordingRecovery.trim(id, endSeconds, startSeconds);
  });
  ipc.handle(IPC_CHANNELS.recoveryPreview, async (_e, id: unknown) => {
    if (typeof id !== 'string' || !id) throw new Error('recovery id required');
    const preview = await s.recordingRecovery.preview(id);
    return { ...preview, url: `recovery-audio://preview?id=${encodeURIComponent(id)}` };
  });
  ipc.handle(IPC_CHANNELS.recoveryReveal, (_e, id: unknown) => {
    if (typeof id !== 'string' || !id) throw new Error('recovery id required');
    return s.recordingRecovery.reveal(id);
  });
  ipc.handle(IPC_CHANNELS.recoveryDismiss, (_e, id: unknown) => {
    if (typeof id !== 'string' || !id) throw new Error('recovery id required');
    s.recordingRecovery.dismiss(id);
  });
  ipc.handle(IPC_CHANNELS.recoveryDiscard, (_e, id: unknown) => {
    if (typeof id !== 'string' || !id) throw new Error('recovery id required');
    return s.recordingRecovery.discard(id);
  });

  ipc.handle(IPC_CHANNELS.meetingDetectorDismiss, (_e, input: unknown) => {
    // Two banner sources (browser-tab URL, native-app bundle id) share one
    // dismissal channel. The renderer sends an object discriminator so the
    // main process knows which detector's suppression list to mutate.
    // Legacy string form (a bare URL) routes to the browser detector for
    // backwards compat with pre-#78 renderers in transient cache.
    if (typeof input === 'string') {
      s.meetingDetector?.dismiss(input);
      return;
    }
    if (!input || typeof input !== 'object') return;
    const obj = input as { kind?: string; url?: string; bundleId?: string };
    if (obj.kind === 'browser-tab' && typeof obj.url === 'string') {
      s.meetingDetector?.dismiss(obj.url);
    } else if (obj.kind === 'native-app' && typeof obj.bundleId === 'string') {
      s.nativeAppDetector?.dismiss(obj.bundleId);
    }
  });

  ipc.handle(IPC_CHANNELS.permissionsAudioGet, () => probeAudioPermissions({ helperPath: s.helperPath }));
  ipc.handle(IPC_CHANNELS.permissionsRequestMic, () => requestMicAccess());
  ipc.handle(IPC_CHANNELS.permissionsMicStatus, () => getMicAccessStatus());
}
