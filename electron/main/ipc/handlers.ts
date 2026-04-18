import type { IpcMain } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { IPC_CHANNELS } from './contracts.js';
import type { MeetingsRepo } from '../storage/meetings-repo.js';
import type { SpeakersRepo } from '../storage/speakers-repo.js';
import type { ActionItemsRepo } from '../storage/action-items-repo.js';
import type { SettingsRepo, Settings } from '../storage/settings-repo.js';
import { DEFAULT_SETTINGS } from '../storage/settings-repo.js';
import type { LMStudioClient } from '../lm-studio/client.js';
import type { AudioHijackBridge } from '../audio-hijack/bridge.js';
import type { RosterService } from '../speakers/roster-service.js';
import type { Pipeline } from '../pipeline/pipeline.js';
import type { Exporter } from '../exporters/interface.js';
import { meetingFolderPath } from '../storage/meeting-folder.js';
import { isStage } from '../lib/stage-machine.js';

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

const MAX_EMBEDDING_DIMS = 8192;
const ConfirmSpeakerSchema = z.object({
  meetingId: z.string().min(1),
  localLabel: z.string().min(1),
  displayName: z.string().min(1).max(200),
  embedding: z
    .array(z.number().refine(Number.isFinite, 'embedding values must be finite'))
    .min(1)
    .max(MAX_EMBEDDING_DIMS),
});

const RerunSchema = z.object({
  id: z.string().min(1),
  fromStage: z.string().refine(isStage, 'invalid stage'),
});

function listMeetingSpeakers(
  speakers: SpeakersRepo,
  meetingId: string,
): { localLabel: string; rosterId: string | null; displayName: string | null; confidence: number | null }[] {
  return speakers.listForMeeting(meetingId).map((s) => ({
    localLabel: s.localLabel,
    rosterId: s.rosterSpeakerId,
    displayName: s.displayName,
    confidence: s.confidence,
  }));
}

function unidentifiedCount(rows: { rosterId: string | null }[]): number {
  return rows.filter((r) => r.rosterId === null).length;
}

export function registerIpcHandlers(ipc: IpcMain, s: IpcServices): void {
  ipc.handle(IPC_CHANNELS.meetingsList, () => {
    // Batch joins/aggregates so this scales O(1) with meetings instead of
    // O(N) queries — LibraryView polls every 3s.
    const speakersByMeeting = s.speakers.listForAllMeetings();
    const counts = s.actionItems.countsByMeeting();
    return s.meetings.listAll().map((m) => {
      const speakers = (speakersByMeeting.get(m.id) ?? []).map((sp) => ({
        localLabel: sp.localLabel,
        rosterId: sp.rosterSpeakerId,
        displayName: sp.displayName,
        confidence: sp.confidence,
      }));
      return {
        id: m.id, slug: m.slug, title: m.title,
        startedAt: m.startedAt, durationS: m.durationS,
        pipelineStage: m.pipelineStage, status: m.status,
        unidentifiedCount: unidentifiedCount(speakers),
        actionItemsCount: counts.get(m.id) ?? 0,
        speakers,
      };
    });
  });

  ipc.handle(IPC_CHANNELS.meetingsGet, (_e, id: string) => {
    const m = s.meetings.findById(id);
    if (!m) return null;
    const folder = meetingFolderPath(s.libraryRoot, m.slug);
    const read = (p: string) => fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
    const speakers = listMeetingSpeakers(s.speakers, id);
    const settingsSnapshot = s.settings.getAll();
    return {
      ...m, slug: m.slug,
      unidentifiedCount: unidentifiedCount(speakers),
      actionItemsCount: s.actionItems.listByMeeting(id).length,
      speakers,
      transcriptMd: read(path.join(folder, 'transcript.md')),
      summaryMd: read(path.join(folder, 'summary.md')),
      audioPath: m.audioPath,
      actionItems: s.actionItems.listByMeeting(id).map((ai) => ({
        id: ai.id, text: ai.text, ownerName: null,
        dueDate: ai.dueDate, status: ai.status, exportedTo: ai.exportedTo,
      })),
      models: { stt: settingsSnapshot.sttModel, llm: settingsSnapshot.llmModel },
    };
  });

  ipc.handle(IPC_CHANNELS.meetingsRename, (_e, id: string, title: string) => {
    if (typeof id !== 'string' || typeof title !== 'string') throw new Error('invalid args');
    return s.meetings.updateTitle(id, title.slice(0, 500));
  });

  ipc.handle(IPC_CHANNELS.meetingsRerun, (_e, id: string, fromStage: string) => {
    const parsed = RerunSchema.parse({ id, fromStage });
    s.meetings.updateStage(parsed.id, parsed.fromStage);
    s.meetings.updateStatus(parsed.id, 'processing');
    s.pipeline.enqueue(parsed.id);
  });

  const startOne = (id: string): boolean => {
    if (typeof id !== 'string' || id.length === 0) return false;
    const m = s.meetings.findById(id);
    if (!m) return false;
    s.meetings.updateStatus(id, 'processing');
    s.pipeline.enqueue(id);
    return true;
  };

  ipc.handle(IPC_CHANNELS.meetingsStart, (_e, id: string) => {
    if (!startOne(id)) throw new Error('meeting not found');
  });

  ipc.handle(IPC_CHANNELS.meetingsStartMany, (_e, ids: unknown) => {
    if (!Array.isArray(ids)) throw new Error('ids must be an array');
    let started = 0;
    for (const id of ids) {
      if (typeof id === 'string' && startOne(id)) started += 1;
    }
    return started;
  });

  ipc.handle(IPC_CHANNELS.recordStart, async (_e, sessionName: string) => s.audioHijack.startSession(sessionName));
  ipc.handle(IPC_CHANNELS.recordStop, async (_e, sessionName: string) => s.audioHijack.stopSession(sessionName));
  ipc.handle(IPC_CHANNELS.recordState, async (_e, sessionName: string) => s.audioHijack.sessionState(sessionName));

  ipc.handle(IPC_CHANNELS.speakersList, () => s.speakers.list());
  ipc.handle(IPC_CHANNELS.speakersConfirm, (_e, input: unknown) => {
    const parsed = ConfirmSpeakerSchema.parse(input);
    const id = s.roster.confirmSpeaker({ displayName: parsed.displayName, embedding: parsed.embedding });
    s.speakers.linkToMeeting(parsed.meetingId, parsed.localLabel, id, 1.0);
    return id;
  });
  ipc.handle(IPC_CHANNELS.speakersRename, (_e, id: string, name: string) => {
    if (typeof id !== 'string' || typeof name !== 'string') throw new Error('invalid args');
    return s.speakers.rename(id, name.slice(0, 200));
  });

  ipc.handle(IPC_CHANNELS.actionItemsSetStatus, (_e, id: string, status: string) => {
    if (status !== 'open' && status !== 'done') throw new Error('invalid status');
    return s.actionItems.setStatus(id, status);
  });

  ipc.handle(IPC_CHANNELS.exportRun, async (_e, input: { exporter: string; meetingId: string }) => {
    if (typeof input?.exporter !== 'string' || typeof input?.meetingId !== 'string') throw new Error('invalid args');
    const meeting = s.meetings.findById(input.meetingId);
    if (!meeting) throw new Error('meeting not found');
    const folder = meetingFolderPath(s.libraryRoot, meeting.slug);
    const items = s.actionItems.listByMeeting(input.meetingId).map((ai) => ({
      id: ai.id, text: ai.text, ownerName: null, dueDate: ai.dueDate, status: ai.status,
    }));
    const exporter = s.exporters[input.exporter];
    if (!exporter) throw new Error(`unknown exporter: ${input.exporter}`);
    const result = await exporter.export({
      items, meetingTitle: meeting.title, meetingFolder: folder,
      onItemExported: (id) => s.actionItems.markExported(id, input.exporter),
    });
    return result;
  });

  ipc.handle(IPC_CHANNELS.settingsGet, () => s.settings.getAll());
  ipc.handle(IPC_CHANNELS.settingsSet, (_e: unknown, key: unknown, value: unknown) => {
    if (typeof key !== 'string' || !(key in DEFAULT_SETTINGS)) throw new Error(`unknown setting: ${String(key)}`);
    return s.settings.set(key as keyof Settings, value as Settings[keyof Settings]);
  });

  ipc.handle(IPC_CHANNELS.modelsList, async () => {
    try { return await s.lmStudio.listModels(); }
    catch { return []; }
  });
}
