import type { IpcMain } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { IPC_CHANNELS } from './contracts';
import type { MeetingsRepo } from '../storage/meetings-repo';
import type { SpeakersRepo } from '../storage/speakers-repo';
import type { ActionItemsRepo } from '../storage/action-items-repo';
import type { SettingsRepo, Settings } from '../storage/settings-repo';
import type { LMStudioClient } from '../lm-studio/client';
import type { AudioHijackBridge } from '../audio-hijack/bridge';
import type { RosterService } from '../speakers/roster-service';
import type { Pipeline } from '../pipeline/pipeline';
import type { Exporter } from '../exporters/interface';
import { meetingFolderPath } from '../storage/meeting-folder';

export interface IpcServices {
  meetings: MeetingsRepo;
  speakers: SpeakersRepo;
  actionItems: ActionItemsRepo;
  settings: SettingsRepo;
  lmStudio: LMStudioClient;
  audioHijack: AudioHijackBridge;
  roster: RosterService;
  pipeline: Pipeline;
  exporters: Record<string, Exporter>;
  libraryRoot: string;
}

export function registerIpcHandlers(ipc: IpcMain, s: IpcServices): void {
  ipc.handle(IPC_CHANNELS.meetingsList, () => {
    return s.meetings.listAll().map((m) => ({
      id: m.id, slug: m.slug, title: m.title,
      startedAt: m.startedAt, durationS: m.durationS,
      pipelineStage: m.pipelineStage, status: m.status,
      unidentifiedCount: 0,
      actionItemsCount: s.actionItems.listByMeeting(m.id).length,
      speakers: [],
    }));
  });

  ipc.handle(IPC_CHANNELS.meetingsGet, (_e, id: string) => {
    const m = s.meetings.findById(id);
    if (!m) return null;
    const folder = meetingFolderPath(s.libraryRoot, m.slug);
    const read = (p: string) => fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
    return {
      ...m, slug: m.slug,
      unidentifiedCount: 0,
      actionItemsCount: s.actionItems.listByMeeting(id).length,
      speakers: [],
      transcriptMd: read(path.join(folder, 'transcript.md')),
      summaryMd: read(path.join(folder, 'summary.md')),
      audioPath: m.audioPath,
      actionItems: s.actionItems.listByMeeting(id).map((ai) => ({
        id: ai.id, text: ai.text, ownerName: null,
        dueDate: ai.dueDate, status: ai.status, exportedTo: ai.exportedTo,
      })),
      models: {},
    };
  });

  ipc.handle(IPC_CHANNELS.meetingsRename, (_e, id: string, title: string) => s.meetings.updateTitle(id, title));

  ipc.handle(IPC_CHANNELS.meetingsRerun, (_e, id: string, fromStage: string) => {
    s.meetings.updateStage(id, fromStage);
    s.pipeline.enqueue(id);
  });

  ipc.handle(IPC_CHANNELS.recordStart, async (_e, sessionName: string) => s.audioHijack.startSession(sessionName));
  ipc.handle(IPC_CHANNELS.recordStop, async (_e, sessionName: string) => s.audioHijack.stopSession(sessionName));
  ipc.handle(IPC_CHANNELS.recordState, async (_e, sessionName: string) => s.audioHijack.sessionState(sessionName));

  ipc.handle(IPC_CHANNELS.speakersList, () => s.speakers.list());
  ipc.handle(IPC_CHANNELS.speakersConfirm, (_e, input: { meetingId: string; localLabel: string; displayName: string; embedding: number[] }) => {
    const id = s.roster.confirmSpeaker({ displayName: input.displayName, embedding: input.embedding });
    s.speakers.linkToMeeting(input.meetingId, input.localLabel, id, 1.0);
    return id;
  });
  ipc.handle(IPC_CHANNELS.speakersRename, (_e, id: string, name: string) => s.speakers.rename(id, name));

  ipc.handle(IPC_CHANNELS.actionItemsSetStatus, (_e, id: string, status: string) => s.actionItems.setStatus(id, status));

  ipc.handle(IPC_CHANNELS.exportRun, async (_e, input: { exporter: string; meetingId: string }) => {
    const meeting = s.meetings.findById(input.meetingId);
    if (!meeting) throw new Error('meeting not found');
    const folder = meetingFolderPath(s.libraryRoot, meeting.slug);
    const items = s.actionItems.listByMeeting(input.meetingId).map((ai) => ({
      id: ai.id, text: ai.text, ownerName: null, dueDate: ai.dueDate, status: ai.status,
    }));
    const exporter = s.exporters[input.exporter];
    if (!exporter) throw new Error(`unknown exporter: ${input.exporter}`);
    const result = await exporter.export({ items, meetingTitle: meeting.title, meetingFolder: folder });
    for (const it of items) s.actionItems.markExported(it.id, input.exporter);
    return result;
  });

  ipc.handle(IPC_CHANNELS.settingsGet, () => s.settings.getAll());
  ipc.handle(IPC_CHANNELS.settingsSet, <K extends keyof Settings>(_e: unknown, key: K, value: Settings[K]) => s.settings.set(key, value));

  ipc.handle(IPC_CHANNELS.modelsList, async () => {
    try { return await s.lmStudio.listModels(); }
    catch { return []; }
  });
}
