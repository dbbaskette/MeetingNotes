import type { IpcMain } from 'electron';
import { app, BrowserWindow, dialog, nativeTheme, shell } from 'electron';
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
import { LMStudioError, REASONING_LOOP_MARKER, type LMStudioClient } from '../lm-studio/client.js';
import { ACTION_ITEM_SYSTEM_PROMPT } from '../pipeline/prompts.js';
import { extractActionItemsFromSummary } from '../pipeline/extract-action-items.js';
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
import { storageLocations } from '../lib/storage-paths.js';
import { stageEtaForMeeting } from './stage-eta-for-meeting.js';
import { transcriptChars } from '../pipeline/transcript-chars.js';
import type { StageDurationsRepo } from '../storage/stage-durations-repo.js';
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
import { clearGateNotified } from '../pipeline/gate-alert.js';
import type { WeeklyAggregator, WeeklyData } from '../weekly/aggregator.js';
import { renderWeeklyMarkdown } from '../weekly/markdown.js';
import { detectProviders, type ProviderAvailability } from '../llm/supervisor.js';
import { downloadWhisperModel } from '../whisper/download-model.js';
import { ripgrepSearch } from '../search/ripgrep-search.js';
import { isMyItem, userIsIdentified, TASK_APP_EXPORTERS } from '../exporters/owner-filter.js';
import type { Logger } from '../logging/logger.js';
import type { GoogleAuth } from '../google/auth.js';
import { tailLogFile } from '../logging/log-tail.js';

export interface IpcServices {
  meetings: MeetingsRepo;
  speakers: SpeakersRepo;
  actionItems: ActionItemsRepo;
  stageDurations: StageDurationsRepo;
  settings: SettingsRepo;
  lmStudio: LMStudioClient;
  /** Lazy-spawn supervisor for the summary LLM. reextract calls
   *  ensureReady() before its chat() call, exactly as the extract stage
   *  does — a no-op when provider='external' (user-managed LM Studio). */
  llmSupervisor: { ensureReady: () => Promise<void> };
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
  logger: Logger;
  googleAuth: GoogleAuth;
  /** Process-lifetime set of meetings we've already alerted about entering the
   *  speaker-ID gate (see pipeline/gate-alert.ts). Cleared here on the three
   *  unblock paths so a genuine re-entry into the gate notifies again. */
  gateNotified: Set<string>;
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

  ipc.handle(IPC_CHANNELS.logsTail, (_e, maxEntries?: unknown) => {
    const n = typeof maxEntries === 'number' && maxEntries > 0
      ? Math.min(maxEntries, 2000)
      : 500;
    return {
      path: s.logger.filePath,
      entries: tailLogFile(s.logger.filePath, { maxEntries: n }),
    };
  });

  ipc.handle(IPC_CHANNELS.logsReveal, () => {
    shell.showItemInFolder(s.logger.filePath);
  });

  ipc.handle(IPC_CHANNELS.googleAuthStart, async () => {
    return s.googleAuth.startSignIn();
  });

  ipc.handle(IPC_CHANNELS.googleAuthStatus, () => ({
    email: s.googleAuth.getConnectedEmail(),
    hasCredentials: s.googleAuth.hasCredentials(),
    signedIn: s.googleAuth.isSignedIn(),
  }));

  ipc.handle(IPC_CHANNELS.googleSignOut, () => {
    s.googleAuth.signOut();
  });

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
      const eta = stageEtaForMeeting(
        s.stageDurations,
        m.pipelineStage,
        () => transcriptChars(s.libraryRoot, m.slug),
      );
      return {
        id: m.id, slug: m.slug, title: m.title,
        startedAt: m.startedAt, durationS: m.durationS,
        pipelineStage: m.pipelineStage, status: m.status,
        errorMessage: m.errorMessage,
        stageStartedAt: m.stageStartedAt,
        skipSpeakerId: m.skipSpeakerId,
        unidentifiedCount: unidentifiedCount(speakers),
        actionItemsCount: counts.get(m.id) ?? 0,
        stageEtaMs: eta?.etaMs ?? null,
        stageEtaRough: eta?.rough ?? false,
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
    // Owner identity for the per-item `isMine` flag — drives the task-app
    // export modal (which lists only the user's own items) and the "set who
    // you are" gate.
    const userSpeakerId = settingsSnapshot.userSpeakerId;
    const me = {
      userSpeakerId,
      userDisplayName: userSpeakerId
        ? (s.speakers.list().find((sp) => sp.id === userSpeakerId)?.displayName ?? null)
        : null,
    };
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
    const eta = stageEtaForMeeting(
      s.stageDurations,
      m.pipelineStage,
      () => transcriptChars(s.libraryRoot, m.slug),
    );
    return {
      ...m, slug: m.slug,
      stageStartedAt: m.stageStartedAt,
      skipSpeakerId: m.skipSpeakerId,
      unidentifiedCount: unidentifiedCount(speakers),
      actionItemsCount: items.length,
      stageEtaMs: eta?.etaMs ?? null,
      stageEtaRough: eta?.rough ?? false,
      speakers,
      // Whether the user has set "You are…" — task-app export is gated on this.
      userIdentified: userIsIdentified(me),
      transcriptMd: read(path.join(folder, 'transcript.md')),
      rawTranscriptText,
      summaryMd: read(path.join(folder, 'summary.md')),
      audioPath: m.audioPath,
      actionItems: items.map((ai) => ({
        id: ai.id, text: ai.text, ownerName: ai.ownerName,
        dueDate: ai.dueDate, status: ai.status, exportedTo: ai.exportedTo,
        sourceQuote: ai.sourceQuote,
        isMine: isMyItem(ai, me),
      })),
      models: { stt: settingsSnapshot.sttModel, llm: settingsSnapshot.llmModel },
    };
  });

  // Light status poll for the detail view's 2s processing loop. Mirrors the
  // per-row shape of meetings:list (DB + learned eta only) — deliberately no
  // transcript/summary/raw-json file reads, which is what makes meetings:get
  // heavy for long meetings.
  ipc.handle(IPC_CHANNELS.meetingsGetStatus, (_e, id: string) => {
    const m = s.meetings.findById(id);
    if (!m) return null;
    const speakers = listMeetingSpeakers(s.speakers, id);
    const eta = stageEtaForMeeting(
      s.stageDurations,
      m.pipelineStage,
      () => transcriptChars(s.libraryRoot, m.slug),
    );
    return {
      id: m.id,
      title: m.title,
      pipelineStage: m.pipelineStage,
      status: m.status,
      errorMessage: m.errorMessage,
      stageStartedAt: m.stageStartedAt,
      stageEtaMs: eta?.etaMs ?? null,
      stageEtaRough: eta?.rough ?? false,
      skipSpeakerId: m.skipSpeakerId,
      unidentifiedCount: unidentifiedCount(speakers),
      actionItemsCount: s.actionItems.listByMeeting(id).length,
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
    // A re-run may drive the meeting back into the gate — clear so it re-alerts.
    clearGateNotified(parsed.id, s.gateNotified);
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
        // Leaving the gate — forget the notified flag so a future re-entry alerts.
        clearGateNotified(id, s.gateNotified);
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
    // Leaving the gate — forget the notified flag so a future re-entry alerts.
    clearGateNotified(id, s.gateNotified);
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

  ipc.handle(IPC_CHANNELS.speakersSuggestions, (_e, meetingId: unknown, localLabel: unknown) => {
    if (typeof meetingId !== 'string' || typeof localLabel !== 'string') throw new Error('invalid args');
    const m = s.meetings.findById(meetingId);
    if (!m) throw new Error('meeting not found');
    const folder = meetingFolderPath(s.libraryRoot, m.slug);
    const diarPath = path.join(folder, 'diarization.json');
    if (!fs.existsSync(diarPath)) return [];
    const diar = JSON.parse(fs.readFileSync(diarPath, 'utf8')) as { segments: DiarizationSegment[] };
    const embedding = averageEmbeddingForLabel(diar.segments, localLabel);
    if (!embedding) return [];
    return s.roster.suggestionsFor({ label: localLabel, embedding });
  });

  ipc.handle(IPC_CHANNELS.speakersUnlink, (_e, meetingId: unknown, localLabel: unknown) => {
    if (typeof meetingId !== 'string' || typeof localLabel !== 'string') throw new Error('invalid args');
    // "Unlink" removes the roster_speaker_id but keeps the meeting_speakers
    // row so the local label still shows up as an unidentified voice.
    s.speakers.linkToMeeting(meetingId, localLabel, null, 0);
  });

  ipc.handle(IPC_CHANNELS.actionItemsSetStatus, (_e, id: unknown, status: unknown) => {
    if (typeof id !== 'string' || id.length === 0) throw new Error('invalid args');
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

  ipc.handle(IPC_CHANNELS.actionItemsReextract, async (_e, meetingId: unknown) => {
    if (typeof meetingId !== 'string' || meetingId.length === 0) throw new Error('invalid args');
    const meeting = s.meetings.findById(meetingId);
    if (!meeting) throw new Error('meeting not found');
    // Re-run ONLY the extract step against the current on-disk summary.md,
    // via the same shared helper the pipeline's extract stage uses.
    // Deliberately state-neutral: we never touch pipelineStage/status, so a
    // 'done' meeting stays 'done' and can't be dragged back into the queue.
    const folder = meetingFolderPath(s.libraryRoot, meeting.slug);
    const { count } = await extractActionItemsFromSummary(
      { ...s, onResample: (retry, words) =>
        s.logger.warn('reextract:reasoning-retry', { meetingId, retry, reasoningWords: words }) },
      meetingId,
      folder,
      'save a summary (with an Action Items section) before re-extracting.',
    );
    s.logger.info('action-items:reextract', { meetingId, items: count });
    return { count };
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
    const exporter = s.exporters[input.exporter];
    if (!exporter) throw new Error(`unknown exporter: ${input.exporter}`);
    const rows = s.actionItems.listByMeeting(input.meetingId);
    let selectedRows = Array.isArray(input.itemIds)
      ? rows.filter((r) => input.itemIds!.includes(r.id))
      : rows;
    // Task-app exporters (Reminders, Google Tasks) push into the user's
    // personal to-do list, so they ONLY ever send items assigned to the
    // user — never the whole meeting's action items. Enforced here as
    // defense-in-depth even though the renderer also pre-filters the modal.
    if (TASK_APP_EXPORTERS.has(input.exporter)) {
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
    // Document exporters (Markdown, Google Doc) render the summary + a
    // checklist, so they're valid with zero items. Task/integration
    // exporters only push action items, so an empty set there is a no-op.
    const DOCUMENT_EXPORTERS = new Set(['markdown', 'google-doc']);
    if (items.length === 0 && !DOCUMENT_EXPORTERS.has(input.exporter)) {
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
    if (key === 'theme') {
      nativeTheme.themeSource = value as 'system' | 'light' | 'dark';
    }
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

  ipc.handle(IPC_CHANNELS.settingsRevealStorage, (_e: unknown, key: unknown) => {
    const rows = storageLocations({
      libraryRoot: s.settings.get('libraryPath'),
      home: os.homedir(),
    });
    const row = rows.find((r) => r.key === key);
    if (!row) throw new Error(`unknown storage location: ${String(key)}`);
    fs.mkdirSync(row.path, { recursive: true });
    shell.showItemInFolder(row.path);
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
    if (typeof model !== 'string') throw new Error('invalid model id');
    // Native streaming download (no shell script). The old path shelled out to
    // scripts/whisper-server.sh, which isn't bundled into the packaged .app —
    // so onboarding's model download failed there with "No such file or
    // directory". downloadWhisperModel validates the id and pulls the ggml
    // file straight into the whisper-models directory. Progress fans out on
    // the onboarding:whisper-progress push channel (throttled to ~4/sec in
    // download-model.ts) so the wizard can render a real progress bar.
    await downloadWhisperModel(model, {
      onProgress: (received, total) => {
        BrowserWindow.getAllWindows().forEach((w) =>
          w.webContents.send(IPC_CHANNELS.onboardingWhisperProgress, { model, received, total }));
      },
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

  ipc.handle(IPC_CHANNELS.onboardingHfTokenStatus, async () => {
    // Report whether a non-empty token file exists — so the wizard's HF step,
    // after the user navigates away and back, shows "already saved" rather than
    // a blank field that looks like the token vanished. We never read the
    // secret back into the renderer.
    const tokenPath = path.join(os.homedir(), '.cache', 'huggingface', 'token');
    let saved = false;
    try { saved = fs.existsSync(tokenPath) && fs.readFileSync(tokenPath, 'utf8').trim().length > 0; }
    catch { saved = false; }
    return { saved };
  });

  ipc.handle(IPC_CHANNELS.onboardingOpenExternal, async (_e, url: unknown) => {
    if (typeof url !== 'string' || !(url.startsWith('https://') || url.startsWith('x-apple.systempreferences:'))) {
      throw new Error('invalid url');
    }
    await shell.openExternal(url);
  });

  // Cmd+K global search (#45). Titles are matched in-memory off the DB;
  // summary/transcript content is searched via the bundled ripgrep
  // binary (@vscode/ripgrep) over the library's meetings/ tree. rg
  // parallelizes the walk and matches with SIMD, so even a multi-
  // thousand-meeting library answers each keystroke in tens of ms.
  ipc.handle(IPC_CHANNELS.searchQuery, async (_e, query: unknown, limit: unknown) => {
    if (typeof query !== 'string') return [];
    const q = query.trim();
    if (q.length < 2) return [];
    const qLower = q.toLowerCase();
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

    // Title hits — rank highest so an exact-title match surfaces first.
    // Pushed down to SQL (LIKE, parameter-bound) instead of scanning a
    // listAll() snapshot per keystroke. Newest-first, capped at `max` —
    // the final slice keeps at most `max` anyway and titles outrank
    // everything else.
    for (const m of s.meetings.searchByTitle(q, max)) {
      hits.push({
        meetingId: m.id, title: m.title, source: 'title',
        snippet: m.title, score: 1000,
      });
    }

    // Content hits — one rg invocation across both file types. We pass
    // --max-count 3 so transcript files cap cleanly; for summaries we
    // additionally take only the first match below (one hit per
    // meeting is plenty, since a summary is short).
    const meetingsRoot = path.join(s.libraryRoot, 'meetings');
    const rgHits = await ripgrepSearch(meetingsRoot, q, {
      maxCountPerFile: 3,
      globs: ['summary.md', 'transcript.md'],
    });

    // Resolve only the slugs rg actually hit — one chunked IN query
    // instead of materializing the entire library.
    const slugFor = (file: string): string | null => {
      // Path shape: {libraryRoot}/meetings/{slug}/(summary|transcript).md
      const segs = path.relative(meetingsRoot, file).split(path.sep);
      return segs.length === 2 ? segs[0]! : null;
    };
    const hitSlugs = [...new Set(
      rgHits.map((r) => slugFor(r.file)).filter((sl): sl is string => sl !== null),
    )];
    const bySlug = new Map(s.meetings.findBySlugs(hitSlugs).map((m) => [m.slug, m]));

    const summarySeen = new Set<string>(); // slug — caps summary hits at 1/meeting
    for (const r of rgHits) {
      const rel = path.relative(meetingsRoot, r.file);
      const segs = rel.split(path.sep);
      if (segs.length !== 2) continue;
      const [slug, basename] = segs;
      const meeting = bySlug.get(slug!);
      if (!meeting) continue;

      if (basename === 'summary.md') {
        if (summarySeen.has(slug!)) continue;
        summarySeen.add(slug!);
        hits.push({
          meetingId: meeting.id,
          title: meeting.title,
          source: 'summary',
          snippet: trimSnippet(r.lineText, qLower, 120),
          score: 500,
        });
      } else if (basename === 'transcript.md') {
        const seconds = parseTimestampSeconds(r.lineText);
        const speakerLabel = parseSpeakerLabel(r.lineText);
        hits.push({
          meetingId: meeting.id,
          title: meeting.title,
          source: 'transcript',
          snippet: speakerLabel
            ? `${speakerLabel}: ${stripTimestampPrefix(r.lineText)}`.slice(0, 200)
            : r.lineText.trim().slice(0, 160),
          ...(seconds !== undefined ? { seconds } : {}),
          score: 100,
        });
      }
    }

    // Sort by score; ties resolve in rg's discovery order (which is
    // already filesystem-driven, not date-sorted — close enough for a
    // palette where the score gap between tiers dominates).
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

  ipc.handle(IPC_CHANNELS.llmHealthCheckModel, async (_e, modelId: unknown) => {
    if (typeof modelId !== 'string' || modelId.length === 0) throw new Error('invalid model id');
    const checkedAt = new Date().toISOString();
    // Short, representative canary — the exact task shape extract really
    // runs (JSON extraction over a summary, not a raw transcript — see the
    // 2026-07-01-extract-from-summary spec). Small enough that a looping
    // model hits the failure fast rather than after several minutes.
    const canarySummary =
      '## Action Items\n' +
      '- Ship the v2 API — Dan — 2026-07-03\n' +
      '- Write the migration guide — Priya — (no date)';
    let verdict: 'ok' | 'loops';
    try {
      await s.lmStudio.chat({
        model: modelId,
        temperature: 0,
        disableThinking: true,
        maxTokens: 1500,
        messages: [
          { role: 'system', content: ACTION_ITEM_SYSTEM_PROMPT },
          { role: 'user', content: canarySummary },
        ],
      });
      verdict = 'ok';
    } catch (e) {
      // Only the specific reasoning-loop failure counts as "loops" — a
      // network error or an unloaded model shouldn't be mislabeled as a
      // reasoning problem.
      if (e instanceof LMStudioError && e.message.includes(REASONING_LOOP_MARKER)) {
        verdict = 'loops';
      } else {
        throw e;
      }
    }
    const result = { verdict, checkedAt };
    const cache = s.settings.get('modelHealthChecks');
    s.settings.set('modelHealthChecks', { ...cache, [modelId]: result });
    return result;
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

// Trim a ripgrep-matched line down to a ~window-char snippet centered on
// the match, with ellipses on either side when truncated. Used for
// summary hits, where the matched line can be a whole paragraph.
function trimSnippet(line: string, qLower: string, window: number): string {
  const text = line.replace(/\s+/g, ' ').trim();
  if (text.length <= window) return text;
  const idx = text.toLowerCase().indexOf(qLower);
  if (idx < 0) return text.slice(0, window) + '…';
  const start = Math.max(0, idx - Math.floor(window / 2));
  const end = Math.min(text.length, start + window);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

// Transcript lines begin with "[Speaker MM:SS]" or "[Speaker HH:MM:SS]"
// (see pipeline/stages/merging.ts). Extract the seconds offset so
// Cmd+Enter can seek the audio to the matched line. Returns undefined
// for lines without a parseable prefix (e.g. an opening header line).
const TIMESTAMP_LINE = /^\[(.+?)\s+(?:(\d+):)?(\d+):(\d{2})\]\s?(.*)$/;

function parseTimestampSeconds(line: string): number | undefined {
  const m = line.match(TIMESTAMP_LINE);
  if (!m) return undefined;
  const hh = m[2] ? parseInt(m[2], 10) : 0;
  return hh * 3600 + parseInt(m[3]!, 10) * 60 + parseInt(m[4]!, 10);
}

function parseSpeakerLabel(line: string): string | undefined {
  const m = line.match(TIMESTAMP_LINE);
  return m ? m[1] : undefined;
}

function stripTimestampPrefix(line: string): string {
  const m = line.match(TIMESTAMP_LINE);
  return (m ? (m[5] ?? '') : line).trim();
}
