import type { IpcMain } from 'electron';
import { app, BrowserWindow, dialog, shell } from 'electron';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
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
import type { NativeAppDetector } from '../meeting-detector/native-app-detector.js';
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
import { moveToTrash, restoreFromTrash } from '../storage/trash.js';
import { remergeTranscript } from '../pipeline/stages/merging.js';
import type { WeeklyAggregator, WeeklyData } from '../weekly/aggregator.js';
import { renderWeeklyMarkdown } from '../weekly/markdown.js';
import { detectProviders, type ProviderAvailability } from '../llm/supervisor.js';

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
  nativeAppDetector?: NativeAppDetector;
  weeklyAggregator: WeeklyAggregator;
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
  ipc.handle(IPC_CHANNELS.appGetVersion, () => app.getVersion());

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
        id: ai.id, text: ai.text, ownerName: ai.ownerName,
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
    if (!m || m.deletedAt) return; // already gone or already soft-deleted — idempotent
    // Soft-delete: move files to the per-meeting trash dir, stamp
    // deleted_at on the row. The undo path (meetingsUndoDelete) moves
    // everything back. Purge expired entries on startup + on a timer.
    try {
      moveToTrash({
        libraryRoot: s.libraryRoot, meetingId: id,
        audioPath: m.audioPath, slug: m.slug,
      });
    } catch { /* partial move is fine; restore will recover what it can */ }
    s.meetings.softDelete(id);
  });

  ipc.handle(IPC_CHANNELS.meetingsUndoDelete, (_e, id: unknown) => {
    if (typeof id !== 'string' || id.length === 0) throw new Error('invalid args');
    const m = s.meetings.findById(id);
    if (!m) return false; // purge already ran
    if (!m.deletedAt) return true; // not deleted — nothing to undo, report success
    const restored = restoreFromTrash(s.libraryRoot, id);
    if (restored) s.meetings.restore(id);
    return restored;
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
    // Diarization runs on the mixed file (see diarizing.ts comment re: #27).
    // Extract the sample clip from the same mixed file so timestamps line up.
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
      // YYYY-MM-DD — lenient: accept empty string as "clear the date".
      normalized.dueDate = dueDate === null || dueDate === '' ? null : dueDate as string;
    }
    s.actionItems.update(id, normalized);
  });

  ipc.handle(IPC_CHANNELS.actionItemsDelete, (_e, id: unknown) => {
    if (typeof id !== 'string' || id.length === 0) throw new Error('invalid args');
    s.actionItems.delete(id);
  });

  ipc.handle(IPC_CHANNELS.actionItemsCreate, (_e, meetingId: unknown, patch: unknown) => {
    if (typeof meetingId !== 'string' || !patch || typeof patch !== 'object') throw new Error('invalid args');
    const { text, ownerName, dueDate } = patch as { text?: unknown; ownerName?: unknown; dueDate?: unknown };
    if (typeof text !== 'string' || text.trim() === '') throw new Error('text required');
    s.actionItems.create(meetingId, {
      text: text.trim().slice(0, 2000),
      ownerName: typeof ownerName === 'string' && ownerName.trim() ? ownerName.trim().slice(0, 200) : null,
      dueDate: typeof dueDate === 'string' && dueDate ? dueDate : null,
    });
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
      id: ai.id, text: ai.text, ownerName: ai.ownerName, dueDate: ai.dueDate, status: ai.status,
    }));
    const items = Array.isArray(input.itemIds)
      ? allItems.filter((ai) => input.itemIds!.includes(ai.id))
      : allItems;
    const exporter = s.exporters[input.exporter];
    if (!exporter) throw new Error(`unknown exporter: ${input.exporter}`);
    const summaryPath = path.join(folder, 'summary.md');
    const summaryMd = fs.existsSync(summaryPath) ? fs.readFileSync(summaryPath, 'utf8') : null;
    // Markdown exports the summary + a checklist. With no items it's still
    // a valid "save this meeting as one file" — don't block it. Other
    // exporters (Apple Reminders, future Google Tasks) only push action
    // items to external systems, so an empty set there would be a no-op
    // at best and confusing at worst.
    if (items.length === 0 && input.exporter !== 'markdown') {
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

  ipc.handle(IPC_CHANNELS.settingsGet, () => s.settings.getAll());
  ipc.handle(IPC_CHANNELS.settingsSet, (_e: unknown, key: unknown, value: unknown) => {
    if (typeof key !== 'string' || !(key in DEFAULT_SETTINGS)) throw new Error(`unknown setting: ${String(key)}`);
    s.settings.set(key as keyof Settings, value as Settings[keyof Settings]);
    // Toggle each meeting detector live when the user flips its switch —
    // no need to restart the app. autoDetectMeetings is the object form
    // post-#78 (browserTabs / nativeApps / silenceMs).
    if (key === 'autoDetectMeetings') {
      const cfg = s.settings.get('autoDetectMeetings');
      if (s.meetingDetector) {
        if (cfg.browserTabs) s.meetingDetector.start();
        else s.meetingDetector.stop();
      }
      if (s.nativeAppDetector) {
        if (cfg.nativeApps) s.nativeAppDetector.start();
        else s.nativeAppDetector.stop();
      }
    }
  });

  ipc.handle(IPC_CHANNELS.modelsList, async () => {
    try { return await s.lmStudio.listModels(); }
    catch { return []; }
  });

  // Onboarding-wizard handlers (#43). Kept out of the main settings
  // block because they're only used during first-run setup.
  ipc.handle(IPC_CHANNELS.onboardingWhisperList, async () => {
    const dir = path.join(os.homedir(), 'Library', 'Application Support', 'MeetingNotes', 'whisper-models');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter((f) => f.startsWith('ggml-') && f.endsWith('.bin'))
      .map((f) => f.replace(/^ggml-/, '').replace(/\.bin$/, ''));
  });

  ipc.handle(IPC_CHANNELS.onboardingWhisperInstall, async (_e, model: unknown) => {
    if (typeof model !== 'string' || !/^[a-z0-9][a-z0-9.\-]*$/i.test(model)) {
      throw new Error('invalid model id');
    }
    // Wrap the existing whisper-server.sh install command. Works in dev
    // (scripts live in the source tree) and in a packaged .app (scripts
    // are extraResources'd too, TODO — for now only dev supports this
    // path cleanly).
    const scriptPath = path.join(process.env.APP_ROOT ?? process.cwd(), 'scripts', 'whisper-server.sh');
    const actualScript = fs.existsSync(scriptPath) ? scriptPath : 'scripts/whisper-server.sh';
    await new Promise<void>((resolve, reject) => {
      execFile('bash', [actualScript, 'install', model], { timeout: 10 * 60 * 1000 }, (err, _stdout, stderr) => {
        if (err) return reject(new Error(stderr || err.message));
        resolve();
      });
    });
  });

  ipc.handle(IPC_CHANNELS.onboardingHfTokenSave, async (_e, token: unknown) => {
    if (typeof token !== 'string' || token.length < 8) throw new Error('invalid token');
    const dir = path.join(os.homedir(), '.cache', 'huggingface');
    fs.mkdirSync(dir, { recursive: true });
    const tokenPath = path.join(dir, 'token');
    fs.writeFileSync(tokenPath, token, { mode: 0o600 });
    // Set perms explicitly in case writeFileSync's mode arg is honored
    // only at file creation on some filesystems.
    try { fs.chmodSync(tokenPath, 0o600); } catch { /* best-effort */ }
  });

  ipc.handle(IPC_CHANNELS.onboardingOpenExternal, async (_e, url: unknown) => {
    if (typeof url !== 'string' || !(url.startsWith('https://') || url.startsWith('x-apple.systempreferences:'))) {
      throw new Error('invalid url');
    }
    await shell.openExternal(url);
  });

  // Cmd+K global search (#45). File-based grep over the meeting library.
  // Works up to a few thousand meetings without needing SQLite FTS5; past
  // that, reach for FTS5 or a proper search index.
  ipc.handle(IPC_CHANNELS.searchQuery, async (_e, query: unknown, limit: unknown) => {
    if (typeof query !== 'string') return [];
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    const max = typeof limit === 'number' && limit > 0 ? Math.min(limit, 100) : 20;

    interface Hit {
      meetingId: string;
      title: string;
      source: 'title' | 'summary' | 'transcript';
      snippet: string;
      seconds?: number;
      score: number;
    }
    const hits: Hit[] = [];

    for (const m of s.meetings.listAll()) {
      const folder = meetingFolderPath(s.libraryRoot, m.slug);
      // Title hit — rank highest so an exact-title match surfaces first.
      if (m.title.toLowerCase().includes(q)) {
        hits.push({
          meetingId: m.id, title: m.title, source: 'title',
          snippet: m.title, score: 1000,
        });
      }
      // Summary — one hit per meeting, showing the first match's line.
      const summaryPath = path.join(folder, 'summary.md');
      if (fs.existsSync(summaryPath)) {
        try {
          const text = fs.readFileSync(summaryPath, 'utf8');
          const lower = text.toLowerCase();
          const idx = lower.indexOf(q);
          if (idx >= 0) {
            const line = snippetAround(text, idx, 120);
            hits.push({
              meetingId: m.id, title: m.title, source: 'summary',
              snippet: line, score: 500,
            });
          }
        } catch { /* ignore unreadable summaries */ }
      }
      // Transcript — one hit per match (up to 3 per meeting so a single
      // noisy word doesn't drown the result list).
      const transcriptPath = path.join(folder, 'transcript.md');
      if (fs.existsSync(transcriptPath)) {
        try {
          const text = fs.readFileSync(transcriptPath, 'utf8');
          const lines = text.split('\n');
          let perMeeting = 0;
          for (const raw of lines) {
            if (perMeeting >= 3) break;
            if (!raw.toLowerCase().includes(q)) continue;
            // Parse leading "[Speaker MM:SS]" to produce a seconds offset.
            const m2 = raw.match(/^\[(.+?)\s+(?:(\d+):)?(\d+):(\d{2})\]\s?(.*)$/);
            if (m2) {
              const hh = m2[2] ? parseInt(m2[2], 10) : 0;
              const seconds = hh * 3600 + parseInt(m2[3]!, 10) * 60 + parseInt(m2[4]!, 10);
              hits.push({
                meetingId: m.id, title: m.title, source: 'transcript',
                snippet: `${m2[1]}: ${(m2[5] ?? '').trim()}`,
                seconds,
                score: 100,
              });
            } else {
              hits.push({
                meetingId: m.id, title: m.title, source: 'transcript',
                snippet: raw.trim().slice(0, 160),
                score: 100,
              });
            }
            perMeeting += 1;
          }
        } catch { /* ignore unreadable transcripts */ }
      }
    }

    // Sort by score, then meeting start desc so newer meetings surface
    // first within the same source tier.
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, max).map((h) => ({
      meetingId: h.meetingId, title: h.title, source: h.source,
      snippet: h.snippet,
      ...(h.seconds !== undefined ? { seconds: h.seconds } : {}),
    }));
  });

  // Weekly summary (#weekly). Year/week pair identifies an ISO week.
  // The aggregator handles cache-or-regenerate based on input hash.
  const validWeek = (y: unknown, w: unknown): { year: number; week: number } | null => {
    if (typeof y !== 'number' || typeof w !== 'number') return null;
    if (!Number.isInteger(y) || !Number.isInteger(w)) return null;
    if (y < 1970 || y > 9999) return null;
    if (w < 1 || w > 53) return null;
    return { year: y, week: w };
  };

  ipc.handle(IPC_CHANNELS.weeklyGet, async (_e, year: unknown, week: unknown): Promise<WeeklyData> => {
    const w = validWeek(year, week);
    if (!w) throw new Error('invalid year/week');
    return s.weeklyAggregator.getWeek(w.year, w.week);
  });

  // Fast path: structured data only (meetings + actions + decisions
  // groups), no LLM call. Used by the WeeklyView's parallel-fetch
  // pattern so the page paints immediately while the narrative is
  // still being drafted.
  ipc.handle(IPC_CHANNELS.weeklyGetStructured, async (_e, year: unknown, week: unknown) => {
    const w = validWeek(year, week);
    if (!w) throw new Error('invalid year/week');
    return s.weeklyAggregator.getStructuredWeek(w.year, w.week);
  });

  // Slow path: returns the cached narrative if fresh, else triggers
  // an LLM call. Pass force=true to bypass the cache (Regenerate).
  ipc.handle(IPC_CHANNELS.weeklyGetNarrative, async (_e, year: unknown, week: unknown, force: unknown) => {
    const w = validWeek(year, week);
    if (!w) throw new Error('invalid year/week');
    return s.weeklyAggregator.getOrGenerateNarrative(w.year, w.week, {
      force: force === true,
    });
  });

  ipc.handle(IPC_CHANNELS.weeklyRegenerate, async (_e, year: unknown, week: unknown): Promise<WeeklyData> => {
    const w = validWeek(year, week);
    if (!w) throw new Error('invalid year/week');
    return s.weeklyAggregator.regenerateWeek(w.year, w.week);
  });

  ipc.handle(IPC_CHANNELS.weeklyExportMarkdown, async (_e, year: unknown, week: unknown): Promise<{ path: string | null; markdown: string }> => {
    const w = validWeek(year, week);
    if (!w) throw new Error('invalid year/week');
    const data = await s.weeklyAggregator.getWeek(w.year, w.week);
    const markdown = renderWeeklyMarkdown(data);
    const filename = `weekly-${w.year}-W${String(w.week).padStart(2, '0')}.md`;
    const result = await dialog.showSaveDialog({
      defaultPath: filename,
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    if (result.canceled || !result.filePath) return { path: null, markdown };
    fs.writeFileSync(result.filePath, markdown, 'utf8');
    return { path: result.filePath, markdown };
  });

  // Phase 3 LLM-provider lifecycle. Settings UI calls this to dim
  // managed-mode options when their CLI isn't installed and to show
  // running-status hints.
  ipc.handle(IPC_CHANNELS.llmDetectProviders, async (): Promise<ProviderAvailability> => {
    return detectProviders();
  });

  // Settings "Test connection" buttons. Both probes time out at 3 s
  // so a misconfigured URL fails fast instead of hanging the form.
  ipc.handle(IPC_CHANNELS.sttProbe, async (
    _e, url: unknown,
  ): Promise<{ ok: true } | { ok: false; error: string }> => {
    if (typeof url !== 'string' || !url) return { ok: false, error: 'invalid url' };
    try {
      const resp = await fetch(`${url.replace(/\/$/, '')}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!resp.ok) return { ok: false, error: `HTTP ${resp.status} from /health` };
      const text = await resp.text();
      try {
        const parsed = JSON.parse(text) as { status?: unknown };
        if (parsed?.status !== 'ok') {
          return { ok: false, error: `/health returned unexpected body — is this whisper-server?` };
        }
        return { ok: true };
      } catch {
        return { ok: false, error: '/health returned non-JSON — likely a different server on this port' };
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: msg.includes('ECONNREFUSED') ? 'connection refused' : msg };
    }
  });

  ipc.handle(IPC_CHANNELS.llmProbe, async (
    _e, url: unknown,
  ): Promise<{ ok: true; models: string[] } | { ok: false; error: string }> => {
    if (typeof url !== 'string' || !url) return { ok: false, error: 'invalid url' };
    try {
      const resp = await fetch(`${url.replace(/\/$/, '')}/v1/models`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!resp.ok) return { ok: false, error: `HTTP ${resp.status} from /v1/models` };
      const body = (await resp.json().catch(() => null)) as
        | { data?: { id?: string }[] }
        | null;
      const models = (body?.data ?? [])
        .map((m) => m.id ?? '')
        .filter((id) => id.length > 0);
      return { ok: true, models };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: msg.includes('ECONNREFUSED') ? 'connection refused' : msg };
    }
  });

  // Pipeline queue controls. Pause/resume don't touch DB rows — they
  // just gate the runner. clear flips queued meetings back to 'pending'
  // so the user can see them and decide whether to re-process.
  // Webhook test-send (#79). Builds a synthetic meeting.completed payload
  // (same shape the auto-fire produces) and POSTs it via the registered
  // webhook exporter. Surfaces the delivery result so the Settings card
  // can show the same status the user would see for a real meeting.
  ipc.handle(IPC_CHANNELS.webhookTestSend, async () => {
    const webhook = s.exporters.webhook as {
      deliverPayload?: (p: unknown) => Promise<{ ts: string; status: number | null; error: string | null }>;
    } | undefined;
    if (!webhook?.deliverPayload) {
      return { ts: new Date().toISOString(), status: null, error: 'webhook exporter is not configured' };
    }
    const cfg = s.settings.getAll();
    const samplePayload = {
      event: 'meeting.completed' as const,
      meeting: {
        id: 'test-sample',
        slug: '2026-01-01-test-sample',
        title: 'Test payload from MeetingNotes',
        started_at: new Date().toISOString(),
        duration_s: 600,
        attendees: cfg.userName ? [cfg.userName] : ['You'],
      },
      summary_markdown: 'This is a synthetic payload from the Settings test button. No real meeting data is included.',
      transcript_markdown: null,
      action_items: [
        { text: 'Confirm your webhook endpoint received this payload', owner: cfg.userName || 'You', due_date: null },
      ],
      links: {
        audio: null,
        transcript_md: null,
        summary_md: null,
        open_in_app: 'meetingnotes://open?id=test-sample',
      },
    };
    return webhook.deliverPayload(samplePayload);
  });

  ipc.handle(IPC_CHANNELS.pipelineStatus, () => s.pipeline.getStatus());
  ipc.handle(IPC_CHANNELS.pipelinePause, () => { s.pipeline.pause(); });
  ipc.handle(IPC_CHANNELS.pipelineResume, () => { s.pipeline.resume(); });
  ipc.handle(IPC_CHANNELS.pipelineClear, () => {
    const cleared = s.pipeline.clearQueue();
    for (const id of cleared) {
      try { s.meetings.updateStatus(id, 'pending'); } catch { /* best-effort */ }
    }
    return { cleared };
  });

  // Transcript export. Renderer hands us the already-formatted content
  // plus the desired filename + format; we show the native save dialog
  // (filtered to the right extension) and write the file. Keeps fs
  // access out of the renderer and matches the WeeklyView export shape.
  ipc.handle(IPC_CHANNELS.transcriptExport, async (
    _e, input: unknown,
  ): Promise<{ path: string | null }> => {
    const obj = (input ?? {}) as { content?: unknown; defaultName?: unknown; format?: unknown };
    const content = typeof obj.content === 'string' ? obj.content : '';
    const defaultName = typeof obj.defaultName === 'string' && obj.defaultName.trim()
      ? obj.defaultName : 'transcript';
    const format: 'md' | 'txt' = obj.format === 'txt' ? 'txt' : 'md';
    if (!content) throw new Error('transcript:export: empty content');
    const filterName = format === 'md' ? 'Markdown' : 'Plain text';
    const result = await dialog.showSaveDialog({
      defaultPath: `${defaultName}.${format}`,
      filters: [{ name: filterName, extensions: [format] }],
    });
    if (result.canceled || !result.filePath) return { path: null };
    fs.writeFileSync(result.filePath, content, 'utf8');
    return { path: result.filePath };
  });

  // Drag-and-drop import. Copies dropped audio files into audioWatchPath
  // (the chokidar-watched folder). The existing watcher then picks them
  // up as new pending meetings — no new pipeline code required.
  ipc.handle(IPC_CHANNELS.meetingsImportDropped, async (
    _e, paths: unknown,
  ): Promise<{ imported: number; skipped: { path: string; reason: string }[] }> => {
    const list = Array.isArray(paths) ? paths.filter((p): p is string => typeof p === 'string') : [];
    const watchDir = s.settings.get('audioWatchPath');
    fs.mkdirSync(watchDir, { recursive: true });
    const allowed = new Set(['.m4a', '.mp3', '.wav', '.aac', '.flac']);
    let imported = 0;
    const skipped: { path: string; reason: string }[] = [];
    for (const src of list) {
      try {
        const ext = path.extname(src).toLowerCase();
        if (!allowed.has(ext)) {
          skipped.push({ path: src, reason: `unsupported format ${ext || '(none)'}` });
          continue;
        }
        if (!fs.existsSync(src) || !fs.statSync(src).isFile()) {
          skipped.push({ path: src, reason: 'not a file' });
          continue;
        }
        // Avoid clobbering: if a same-named file already exists in the
        // watch folder, append a short timestamp to disambiguate.
        const base = path.basename(src);
        let dest = path.join(watchDir, base);
        if (fs.existsSync(dest)) {
          const stem = path.basename(base, ext);
          const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
          dest = path.join(watchDir, `${stem}-${stamp}${ext}`);
        }
        fs.copyFileSync(src, dest);
        imported += 1;
      } catch (e) {
        skipped.push({ path: src, reason: e instanceof Error ? e.message : String(e) });
      }
    }
    return { imported, skipped };
  });
}

// Extract a ~n-char window around an index, expanded to word boundaries
// and with ellipses on either side when truncated.
function snippetAround(text: string, idx: number, window: number): string {
  const start = Math.max(0, idx - Math.floor(window / 2));
  const end = Math.min(text.length, idx + Math.ceil(window / 2));
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  return `${prefix}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${suffix}`;
}
