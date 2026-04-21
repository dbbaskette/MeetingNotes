import type { IpcMain } from 'electron';
import { BrowserWindow, dialog } from 'electron';
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
import type { RecordingManager } from '../recording/manager.js';
import type { AppEnumerator } from '../recording/app-enumerator.js';
import type { MeetingDetector } from '../meeting-detector/detector.js';
import { probeAudioPermissions, requestMicAccess, getMicAccessStatus } from '../permissions/audio.js';
import type { RosterService } from '../speakers/roster-service.js';
import type { Pipeline } from '../pipeline/pipeline.js';
import type { Exporter } from '../exporters/interface.js';
import { meetingFolderPath } from '../storage/meeting-folder.js';
import { isStage } from '../lib/stage-machine.js';
import {
  clearArtifactsFromStage,
  shouldClearActionItems,
  shouldClearSpeakerLinks,
} from '../pipeline/clear-artifacts.js';
import {
  extractSpeakerSample,
  averageEmbeddingForLabel,
  type DiarizationSegment,
} from '../speakers/sample-extractor.js';
import { remergeTranscript } from '../pipeline/stages/merging.js';

export interface IpcServices {
  meetings: MeetingsRepo;
  speakers: SpeakersRepo;
  actionItems: ActionItemsRepo;
  settings: SettingsRepo;
  lmStudio: LMStudioClient;
  recordingManager: RecordingManager;
  appEnumerator: AppEnumerator;
  helperPath: string;
  roster: RosterService;
  pipeline: Pipeline;
  exporters: Record<string, Exporter>;
  libraryRoot: string;
  meetingDetector?: MeetingDetector;
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
        stageStartedAt: m.stageStartedAt,
        skipSpeakerId: m.skipSpeakerId,
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
    const items = s.actionItems.listByMeeting(id);
    // Show a raw (speaker-less) preview as soon as the whisper step completes,
    // before merge produces transcript.md. Gives the user something to read
    // while diarization is still running.
    let rawTranscriptText: string | null = null;
    const rawJson = read(path.join(folder, 'transcript.raw.json'));
    if (rawJson) {
      try {
        const parsed = JSON.parse(rawJson) as { text?: string };
        if (typeof parsed.text === 'string' && parsed.text.length > 0) {
          rawTranscriptText = parsed.text;
        }
      } catch { /* ignore */ }
    }
    return {
      ...m, slug: m.slug,
      stageStartedAt: m.stageStartedAt,
      skipSpeakerId: m.skipSpeakerId,
      unidentifiedCount: unidentifiedCount(speakers),
      actionItemsCount: items.length,
      speakers,
      transcriptMd: read(path.join(folder, 'transcript.md')),
      rawTranscriptText,
      summaryMd: read(path.join(folder, 'summary.md')),
      audioPath: m.audioPath,
      actionItems: items.map((ai) => ({
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

  ipc.handle(IPC_CHANNELS.meetingsDelete, (_e, id: unknown) => {
    if (typeof id !== 'string' || id.length === 0) throw new Error('invalid args');
    const m = s.meetings.findById(id);
    if (!m) return; // already gone — treat as success
    // File cleanup order: audio first (+ stem siblings), then meeting folder,
    // then DB row. If any of the filesystem steps fails we still drop the
    // row — a partial delete is preferable to an inconsistent UI where the
    // row lingers but the audio is gone.
    const tryUnlink = (p: string): void => {
      try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch { /* best-effort */ }
    };
    // Mixed file.
    tryUnlink(m.audioPath);
    // Stem siblings (#13 Phase 1). Same derivation as lib/stem-paths.ts —
    // inlined to keep this handler self-contained. Safe no-op if absent.
    const ext = path.extname(m.audioPath);
    const base = ext ? m.audioPath.slice(0, -ext.length) : m.audioPath;
    tryUnlink(`${base}.voice${ext}`);
    tryUnlink(`${base}.system${ext}`);
    // Meeting folder (transcripts, summaries, exports, meeting.json).
    try {
      const folder = meetingFolderPath(s.libraryRoot, m.slug);
      if (fs.existsSync(folder)) fs.rmSync(folder, { recursive: true, force: true });
    } catch { /* best-effort */ }
    s.meetings.delete(id);
  });

  ipc.handle(IPC_CHANNELS.meetingsRerun, (_e, id: string, fromStage: string) => {
    const parsed = RerunSchema.parse({ id, fromStage });
    // Clear stale artifacts & DB rows for the stage we're rewinding to, so the
    // UI doesn't keep showing yesterday's bad transcript while the retry runs.
    const meeting = s.meetings.findById(parsed.id);
    if (meeting) {
      const folder = meetingFolderPath(s.libraryRoot, meeting.slug);
      clearArtifactsFromStage(folder, parsed.fromStage);
    }
    if (shouldClearActionItems(parsed.fromStage)) s.actionItems.deleteForMeeting(parsed.id);
    if (shouldClearSpeakerLinks(parsed.fromStage)) s.speakers.unlinkMeeting(parsed.id);
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

  ipc.handle(IPC_CHANNELS.meetingsSetSkipSpeakerId, (_e, id: unknown, skip: unknown) => {
    if (typeof id !== 'string' || typeof skip !== 'boolean') throw new Error('invalid args');
    s.meetings.updateSkipSpeakerId(id, skip);
    // If the meeting was parked at the gate and the user just said "skip it,"
    // re-enqueue so the pipeline runs past the gate immediately. If skip went
    // false and we're past the gate, there's nothing to do — can't re-pause.
    if (skip) {
      const m = s.meetings.findById(id);
      if (m?.pipelineStage === 'awaiting_speaker_id') {
        // Re-merge transcript.md with whatever identifications the user made
        // before flipping the skip switch — they may have labeled some but
        // not all voices, and they still deserve names in the transcript.
        try {
          remergeTranscript(id, { libraryRoot: s.libraryRoot, meetings: s.meetings, speakers: s.speakers, userName: s.settings.get('userName') });
        } catch { /* first-pass merge hadn't run? fall through — summarize will still work off meeting_speakers */ }
        s.meetings.updateStatus(id, 'processing');
        s.pipeline.enqueue(id);
      }
    }
  });

  ipc.handle(IPC_CHANNELS.meetingsContinueFromSpeakerId, (_e, id: unknown) => {
    if (typeof id !== 'string') throw new Error('invalid args');
    const m = s.meetings.findById(id);
    if (!m) throw new Error('meeting not found');
    // Only meaningful when parked at the gate — guard so an accidental double-
    // click or stale UI state can't re-kick a meeting that's already running.
    if (m.pipelineStage !== 'awaiting_speaker_id') return;
    // Rewrite transcript.md with the user's roster assignments BEFORE
    // summarize runs on it. This is why we re-merge here instead of just
    // bumping the stage — the whole point of the gate is giving the user a
    // chance to replace SPEAKER_00 with real names in the final output.
    try {
      remergeTranscript(id, { libraryRoot: s.libraryRoot, meetings: s.meetings, speakers: s.speakers, userName: s.settings.get('userName') });
    } catch { /* see note above */ }
    // Advance manually to 'summarizing' so the pipeline's linear loop picks up
    // on the right side of the gate. (We don't flip skipSpeakerId — the user
    // chose to identify this meeting, which doesn't imply they want to skip
    // future ones.)
    s.meetings.updateStage(id, 'summarizing');
    s.meetings.updateStatus(id, 'processing');
    s.pipeline.enqueue(id);
  });

  ipc.handle(IPC_CHANNELS.meetingsSaveSummary, (_e, id: unknown, markdown: unknown) => {
    if (typeof id !== 'string' || typeof markdown !== 'string') throw new Error('invalid args');
    // Cap at ~5MB to defang a runaway editor sending a giant blob; real
    // summaries are <20KB. Anything bigger is a bug, not a feature.
    if (markdown.length > 5_000_000) throw new Error('summary too large');
    const meeting = s.meetings.findById(id);
    if (!meeting) throw new Error('meeting not found');
    const folder = meetingFolderPath(s.libraryRoot, meeting.slug);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'summary.md'), markdown);
    return markdown;
  });

  ipc.handle(IPC_CHANNELS.meetingsStartMany, (_e, ids: unknown) => {
    if (!Array.isArray(ids)) throw new Error('ids must be an array');
    let started = 0;
    for (const id of ids) {
      if (typeof id === 'string' && startOne(id)) started += 1;
    }
    return started;
  });

  // Built-in recording namespace. The renderer asks for a list of audible
  // apps, picks one, and the manager spawns the bundled meeting-notes-tap
  // helper. Level + state-change events are broadcast via webContents.send
  // (wired up where the manager is constructed in electron/main/index.ts).
  ipc.handle(IPC_CHANNELS.recordingListSources, async () => s.appEnumerator.list());
  ipc.handle(IPC_CHANNELS.recordingStart, async (_e, input: unknown) => {
    if (typeof input !== 'object' || input === null) throw new Error('invalid args');
    const { targetPid, targetLabel, mic } = input as {
      targetPid: number | 'system'; targetLabel: string; mic: boolean;
    };
    return s.recordingManager.start({ targetPid, targetLabel, mic });
  });
  ipc.handle(IPC_CHANNELS.recordingStop, async (_e, sessionId: unknown) => {
    if (typeof sessionId !== 'string') throw new Error('sessionId required');
    return s.recordingManager.stop(sessionId);
  });
  ipc.handle(IPC_CHANNELS.recordingState, (_e, sessionId: unknown) => {
    if (typeof sessionId !== 'string') throw new Error('sessionId required');
    return s.recordingManager.state(sessionId);
  });

  ipc.handle(IPC_CHANNELS.meetingDetectorDismiss, (_e, url: unknown) => {
    if (typeof url !== 'string' || !s.meetingDetector) return;
    s.meetingDetector.dismiss(url);
  });

  ipc.handle(IPC_CHANNELS.permissionsAudioGet, () => probeAudioPermissions({ helperPath: s.helperPath }));
  ipc.handle(IPC_CHANNELS.permissionsRequestMic, () => requestMicAccess());
  ipc.handle(IPC_CHANNELS.permissionsMicStatus, () => getMicAccessStatus());

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

  ipc.handle(IPC_CHANNELS.speakersSample, async (_e, meetingId: unknown, localLabel: unknown) => {
    if (typeof meetingId !== 'string' || typeof localLabel !== 'string') throw new Error('invalid args');
    const m = s.meetings.findById(meetingId);
    if (!m) throw new Error('meeting not found');
    const folder = meetingFolderPath(s.libraryRoot, m.slug);
    const diarPath = path.join(folder, 'diarization.json');
    if (!fs.existsSync(diarPath)) return null;
    const clip = await extractSpeakerSample({
      audioPath: m.audioPath,
      diarizationPath: diarPath,
      sampleDir: path.join(folder, 'samples'),
      localLabel,
    });
    if (!clip) return null;
    // Inline as data URI: samples are small (~50KB at 64kbps mono 22kHz for 8s)
    // and this sidesteps Electron's file:// restrictions in the renderer.
    const bytes = await fs.promises.readFile(clip.path);
    const dataUri = `data:audio/mpeg;base64,${bytes.toString('base64')}`;
    return { dataUri, startS: clip.startS, endS: clip.endS };
  });

  const AssignSchema = z.object({
    meetingId: z.string().min(1),
    localLabel: z.string().min(1),
    mode: z.enum(['existing', 'new']),
    rosterId: z.string().min(1).optional(),
    displayName: z.string().min(1).max(200).optional(),
  });
  ipc.handle(IPC_CHANNELS.speakersAssign, (_e, input: unknown) => {
    const parsed = AssignSchema.parse(input);
    const m = s.meetings.findById(parsed.meetingId);
    if (!m) throw new Error('meeting not found');

    if (parsed.mode === 'existing') {
      if (!parsed.rosterId) throw new Error('rosterId required for mode=existing');
      // Reinforce the roster entry's embedding with this new observation —
      // the speaker sounded close enough for the user to confirm a match,
      // so averaging that into the saved embedding makes future automatic
      // matches more reliable.
      const folder = meetingFolderPath(s.libraryRoot, m.slug);
      const diarPath = path.join(folder, 'diarization.json');
      if (fs.existsSync(diarPath)) {
        try {
          const diar = JSON.parse(fs.readFileSync(diarPath, 'utf8')) as {
            segments: DiarizationSegment[];
          };
          const embedding = averageEmbeddingForLabel(diar.segments, parsed.localLabel);
          if (embedding) s.roster.confirmSpeakerFor(parsed.rosterId, embedding);
        } catch { /* roster update is best-effort; don't fail the link */ }
      }
      s.speakers.linkToMeeting(parsed.meetingId, parsed.localLabel, parsed.rosterId, 1.0);
      return parsed.rosterId;
    }

    // mode === 'new': derive the embedding from diarization.json so the
    // renderer never touches raw embeddings.
    if (!parsed.displayName) throw new Error('displayName required for mode=new');
    const folder = meetingFolderPath(s.libraryRoot, m.slug);
    const diarPath = path.join(folder, 'diarization.json');
    if (!fs.existsSync(diarPath)) throw new Error('diarization not available yet');
    const diar = JSON.parse(fs.readFileSync(diarPath, 'utf8')) as { segments: DiarizationSegment[] };
    const embedding = averageEmbeddingForLabel(diar.segments, parsed.localLabel);
    if (!embedding) throw new Error(`no embeddings for ${parsed.localLabel}`);
    const id = s.roster.confirmSpeaker({ displayName: parsed.displayName, embedding });
    s.speakers.linkToMeeting(parsed.meetingId, parsed.localLabel, id, 1.0);
    return id;
  });

  ipc.handle(IPC_CHANNELS.speakersUnlink, (_e, meetingId: unknown, localLabel: unknown) => {
    if (typeof meetingId !== 'string' || typeof localLabel !== 'string') throw new Error('invalid args');
    // "Unlink" removes the roster_speaker_id but keeps the meeting_speakers
    // row so the local label still shows up as an unidentified voice.
    s.speakers.linkToMeeting(meetingId, localLabel, null, 0);
  });

  ipc.handle(IPC_CHANNELS.actionItemsSetStatus, (_e, id: string, status: string) => {
    if (status !== 'open' && status !== 'done') throw new Error('invalid status');
    return s.actionItems.setStatus(id, status);
  });

  ipc.handle(IPC_CHANNELS.exportRun, async (_e, input: {
    exporter: string;
    meetingId: string;
    itemIds?: string[]; // optional subset; omitted = all open items (legacy behavior)
    outputPath?: string; // optional file path for file-based exporters (markdown)
  }) => {
    if (typeof input?.exporter !== 'string' || typeof input?.meetingId !== 'string') throw new Error('invalid args');
    const meeting = s.meetings.findById(input.meetingId);
    if (!meeting) throw new Error('meeting not found');
    const folder = meetingFolderPath(s.libraryRoot, meeting.slug);
    const allItems = s.actionItems.listByMeeting(input.meetingId).map((ai) => ({
      id: ai.id, text: ai.text, ownerName: null, dueDate: ai.dueDate, status: ai.status,
    }));
    const items = Array.isArray(input.itemIds)
      ? allItems.filter((ai) => input.itemIds!.includes(ai.id))
      : allItems;
    if (items.length === 0) throw new Error('No action items selected');
    const exporter = s.exporters[input.exporter];
    if (!exporter) throw new Error(`unknown exporter: ${input.exporter}`);
    const summaryPath = path.join(folder, 'summary.md');
    const summaryMd = fs.existsSync(summaryPath) ? fs.readFileSync(summaryPath, 'utf8') : null;
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

  ipc.handle(IPC_CHANNELS.settingsGet, () => s.settings.getAll());
  ipc.handle(IPC_CHANNELS.settingsSet, (_e: unknown, key: unknown, value: unknown) => {
    if (typeof key !== 'string' || !(key in DEFAULT_SETTINGS)) throw new Error(`unknown setting: ${String(key)}`);
    s.settings.set(key as keyof Settings, value as Settings[keyof Settings]);
    // Toggle the meeting detector live when the user flips the setting —
    // no need to restart the app.
    if (key === 'autoDetectMeetings' && s.meetingDetector) {
      if (value) s.meetingDetector.start();
      else s.meetingDetector.stop();
    }
  });

  ipc.handle(IPC_CHANNELS.modelsList, async () => {
    try { return await s.lmStudio.listModels(); }
    catch { return []; }
  });
}
