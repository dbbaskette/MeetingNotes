import type { IpcMain } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { recordingsDirFor } from '../lib/storage-paths.js';
import { importAudioFiles } from '../library/import-dropped.js';
import { IPC_CHANNELS, MeetingListQuerySchema, MeetingListFilterSchema, MeetingIdsSchema,
  GroupIdSchema, GroupNameSchema, OptionalGroupScopeSchema, AssignGroupSchema,
  type MeetingSummary, type MeetingSummaryPage, type MeetingStartManyResult } from './contracts.js';
import type { SpeakersRepo } from '../storage/speakers-repo.js';
import type { MeetingRow } from '../storage/meetings-repo.js';
import type { IpcServices } from './handlers.js';
import { briefPrepSections, briefSection } from '../../shared/productivity.js';
import { meetingFolderPath } from '../storage/meeting-folder.js';
import { isStage } from '../lib/stage-machine.js';
import { stageEtaForMeeting } from './stage-eta-for-meeting.js';
import { transcriptChars } from '../pipeline/transcript-chars.js';
import { preserveTranscript } from '../pipeline/preserve-transcript.js';
import {
  clearArtifactsFromStage,
  shouldClearActionItems,
  shouldClearSpeakerLinks,
} from '../pipeline/clear-artifacts.js';
import { moveToTrash, restoreFromTrash, purgeTrashDir, TRASH_RETENTION_MS } from '../storage/trash.js';
import { remergeTranscript } from '../pipeline/stages/merging.js';
import { clearGateNotified } from '../pipeline/gate-alert.js';
import { isMyItem, userIsIdentified } from '../exporters/owner-filter.js';
import { createCountsCache } from '../library/page-counts.js';
import { TRANSCRIPTION_ENGINE_LABELS } from '../../shared/native-speech.js';
import { listMeetingSpeakers, unidentifiedCount, speakerReviewForFolder } from './meeting-speakers.js';

const RerunSchema = z.object({
  id: z.string().min(1),
  fromStage: z.string().refine(isStage, 'invalid stage'),
});

function meetingSummary(
  s: IpcServices,
  m: MeetingRow,
  links: ReturnType<SpeakersRepo['listForMeeting']>,
  actionItemsCount: number,
): MeetingSummary {
  const speakers = links.map((sp) => ({
    localLabel: sp.localLabel, rosterId: sp.rosterSpeakerId,
    displayName: sp.displayName, confidence: sp.confidence, assignmentSource: sp.assignmentSource,
  }));
  const eta = m.status === 'processing'
    ? stageEtaForMeeting(s.stageDurations, m.pipelineStage, () => transcriptChars(s.libraryRoot, m.slug))
    : null;
  return {
    id: m.id, slug: m.slug, title: m.title, createdAt: m.createdAt,
    groupId: m.groupId, groupName: m.groupName,
    startedAt: m.startedAt, durationS: m.durationS,
    pipelineStage: m.pipelineStage, status: m.status,
    errorMessage: m.errorMessage, stageStartedAt: m.stageStartedAt, skipSpeakerId: m.skipSpeakerId,
    unidentifiedCount: unidentifiedCount(speakers), actionItemsCount,
    stageEtaMs: eta?.etaMs ?? null, stageEtaRough: eta?.rough ?? false, speakers,
  };
}

function scopedMeetingSummaries(s: IpcServices, rows: MeetingRow[]): MeetingSummary[] {
  if (rows.length === 0) return [];
  const ids = rows.map((m) => m.id);
  const speakers = s.speakers.listForMeetings(ids);
  const counts = s.actionItems.countsForMeetings(ids);
  return rows.map((m) => meetingSummary(s, m, speakers.get(m.id) ?? [], counts.get(m.id) ?? 0));
}

/** Status-list shape for Needs Attention: skip speaker/action joins and ETA
 *  file probes. The panel only needs id/title/status/stage/startedAt. */
function shellMeetingSummaries(rows: MeetingRow[]): MeetingSummary[] {
  return rows.map((m) => ({
    id: m.id, slug: m.slug, title: m.title,
    groupId: m.groupId, groupName: m.groupName,
    startedAt: m.startedAt, durationS: m.durationS,
    pipelineStage: m.pipelineStage, status: m.status,
    errorMessage: m.errorMessage, stageStartedAt: m.stageStartedAt, skipSpeakerId: m.skipSpeakerId,
    unidentifiedCount: 0, actionItemsCount: 0,
    stageEtaMs: null, stageEtaRough: false, speakers: [],
  }));
}

export function registerMeetingListHandlers(ipc: IpcMain, s: IpcServices): void {
  const pageCounts = createCountsCache();
  ipc.handle(IPC_CHANNELS.meetingsListPage, (_e, input: unknown): MeetingSummaryPage => {
    const query = MeetingListQuerySchema.parse(input);
    const page = s.meetings.listPage(query);
    const counts = pageCounts.forQuery(query, () => s.meetings.counts(query.groupId));
    return { items: scopedMeetingSummaries(s, page.rows), nextCursor: page.nextCursor,
      total: counts[query.filter], counts };
  });

  ipc.handle(IPC_CHANNELS.meetingsGetMany, (_e, input: unknown, opts?: unknown): MeetingSummary[] => {
    const ids = MeetingIdsSchema.parse(input);
    const rows = s.meetings.findByIds(ids);
    const shell = Boolean(opts && typeof opts === 'object' && (opts as { shell?: unknown }).shell === true);
    return shell ? shellMeetingSummaries(rows) : scopedMeetingSummaries(s, rows);
  });

  ipc.handle(IPC_CHANNELS.meetingsListIds, (_e, input: unknown, groupId: unknown): string[] =>
    s.meetings.listIds(MeetingListFilterSchema.parse(input), OptionalGroupScopeSchema.parse(groupId)));
}

export function registerGroupHandlers(ipc: IpcMain, s: IpcServices): void {
  ipc.handle(IPC_CHANNELS.groupsList, () => s.groups.listWithCounts());
  ipc.handle(IPC_CHANNELS.groupsPin, (_e, id: string, pinned: boolean) => s.groups.pin(id, pinned));
  ipc.handle(IPC_CHANNELS.groupsBrief, async (_e, id: string) => {
    const rows = s.groups.recentMeetings(id);
    const meetings = await Promise.all(rows.map(async row => {
      const notes = await s.artifactCache.readText(path.join(meetingFolderPath(s.libraryRoot, row.slug), 'summary.md'));
      return { id: row.id, title: row.title, startedAt: row.startedAt, missingNotes: !notes,
        decisions: briefSection(notes ?? '', 'Decisions'), questions: briefSection(notes ?? '', 'Open Questions'),
        overview: briefSection(notes ?? '', 'Overview').join(' ').slice(0, 1500),
        prep: briefPrepSections(notes ?? '') };
    }));
    const actions = s.actionItems.live({ owner: 'all', groupId: id }, { id: null, name: null });
    return { meetings, actions: actions.items, openActionCount: actions.total };
  });
  ipc.handle(IPC_CHANNELS.groupsCreate, (_e, name: unknown) => s.groups.create(GroupNameSchema.parse(name)));
  ipc.handle(IPC_CHANNELS.groupsRename, (_e, id: unknown, name: unknown) => {
    s.groups.rename(GroupIdSchema.parse(id), GroupNameSchema.parse(name));
  });
  ipc.handle(IPC_CHANNELS.groupsDelete, (_e, id: unknown) => s.groups.delete(GroupIdSchema.parse(id)));
  ipc.handle(IPC_CHANNELS.groupsAssign, (_e, input: unknown) => {
    const { ids, groupId, expectedGroupId } = AssignGroupSchema.parse(input);
    return s.groups.assign(ids, groupId, expectedGroupId);
  });
  ipc.handle(IPC_CHANNELS.groupsUndo, (_e, input: unknown) => s.groups.undo(z.array(z.object({
    id: z.string().min(1).max(100), previousGroupId: GroupIdSchema.nullable(), revision: z.number().int().positive(),
  })).max(1000).parse(input)));
}

export function registerMeetingHandlers(ipc: IpcMain, s: IpcServices): void {
  ipc.handle(IPC_CHANNELS.meetingsGet, async (_e, id: unknown) => {
    if (typeof id !== 'string' || id.length === 0) throw new Error('meeting id required');
    const m = s.meetings.findById(id);
    if (!m) return null;
    const folder = meetingFolderPath(s.libraryRoot, m.slug);
    const speakers = listMeetingSpeakers(s.speakers, id);
    const settingsSnapshot = s.settings.getAll();
    // Tiny per-run manifest + summary read concurrently through the cache.
    // Historical meetings without provenance must not be relabelled as Apple.
    const [speech, summaryMd] = await Promise.all([
      s.artifactCache.readJson<{ provider?: string; engine?: string }>(path.join(folder, 'processing-speech.json')).catch(() => null),
      s.artifactCache.readText(path.join(folder, 'summary.md')),
    ]);
    const items = s.actionItems.listByMeeting(id);
    // Owner identity for the per-item `isMine` flag — drives the task-app
    // export modal (which lists only the user's own items) and the "set who
    // you are" gate.
    const userSpeakerId = settingsSnapshot.userSpeakerId;
    const me = {
      userSpeakerId,
      userDisplayName: userSpeakerId
        ? ((typeof s.speakers.findById === 'function'
          ? s.speakers.findById(userSpeakerId)
          : s.speakers.list().find((sp) => sp.id === userSpeakerId))?.displayName ?? null)
        : null,
    };
    const eta = m.status === 'processing'
      ? stageEtaForMeeting(
          s.stageDurations,
          m.pipelineStage,
          () => transcriptChars(s.libraryRoot, m.slug),
        )
      : null;
    return {
      ...m, slug: m.slug,
      processingHistory: s.meetings.processingHistory(id),
      stageStartedAt: m.stageStartedAt,
      skipSpeakerId: m.skipSpeakerId,
      unidentifiedCount: unidentifiedCount(speakers),
      actionItemsCount: items.length,
      stageEtaMs: eta?.etaMs ?? null,
      stageEtaRough: eta?.rough ?? false,
      speakers,
      // Whether the user has set "You are…" — task-app export is gated on this.
      userIdentified: userIsIdentified(me),
      summaryMd,
      summaryStale: s.terminology?.stale(id as string) ?? false,
      audioPath: m.audioPath,
      actionItems: items.map((ai) => ({
        id: ai.id, text: ai.text, ownerName: ai.ownerName,
        dueDate: ai.dueDate, status: ai.status, exportedTo: ai.exportedTo,
        sourceQuote: ai.sourceQuote,
        isMine: isMyItem(ai, me),
      })),
      // The engine pinned for this meeting's last speech run, not the current setting.
      models: { stt: speech?.provider === 'native' ? TRANSCRIPTION_ENGINE_LABELS[speech.engine === 'whisperkit' ? 'whisperkit' : 'apple'] : undefined, llm: settingsSnapshot.llmModel },
    };
  });

  ipc.handle(IPC_CHANNELS.meetingsGetTranscript, async (_e, id: unknown) => {
    if (typeof id !== 'string' || id.length === 0) throw new Error('meeting id required');
    const meeting = s.meetings.findById(id);
    if (!meeting) return null;
    const folder = meetingFolderPath(s.libraryRoot, meeting.slug);
    const transcriptMd = await s.artifactCache.readText(path.join(folder, 'transcript.md'));
    if (transcriptMd) return { transcriptMd, rawTranscriptText: null };
    const raw = await s.artifactCache.readJson<{ text?: string }>(path.join(folder, 'transcript.raw.json'));
    return {
      transcriptMd: null,
      rawTranscriptText: typeof raw?.text === 'string' && raw.text.length > 0 ? raw.text : null,
    };
  });

  ipc.handle(IPC_CHANNELS.meetingsGetSpeakerReview, async (_e, id: unknown) => {
    if (typeof id !== 'string' || id.length === 0) throw new Error('meeting id required');
    const meeting = s.meetings.findById(id);
    if (!meeting) return null;
    const speakers = listMeetingSpeakers(s.speakers, id);
    const review = await speakerReviewForFolder(
      meetingFolderPath(s.libraryRoot, meeting.slug), speakers, s.artifactCache,
    );
    return {
      speakers: speakers.map((speaker) => ({
        ...speaker,
        ...(review.get(speaker.localLabel) ?? {
          state: speaker.rosterId ? (speaker.assignmentSource === 'automatic' ? 'automatic' : (speaker.confidence ?? 0) >= 0.999 ? 'confirmed' : 'probable') : 'unknown',
          needsReview: !speaker.rosterId, segmentCount: 0, durationS: 0, lineCount: 0,
        }),
      })),
    };
  });

  // Light status poll for the detail view's 2s processing loop. Mirrors the
  // per-row shape of meetings:list (DB + learned eta only) — deliberately no
  // transcript/summary/raw-json file reads, which is what makes meetings:get
  // heavy for long meetings.
  ipc.handle(IPC_CHANNELS.meetingsGetStatus, (_e, id: unknown) => {
    if (typeof id !== 'string' || id.length === 0) throw new Error('meeting id required');
    const m = s.meetings.findById(id);
    if (!m) return null;
    const speakers = listMeetingSpeakers(s.speakers, id);
    const eta = m.status === 'processing'
      ? stageEtaForMeeting(
          s.stageDurations,
          m.pipelineStage,
          () => transcriptChars(s.libraryRoot, m.slug),
        )
      : null;
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
      actionItemsCount: typeof s.actionItems.countByMeeting === 'function'
        ? s.actionItems.countByMeeting(id)
        : s.actionItems.listByMeeting(id).length,
    };
  });

  ipc.handle(IPC_CHANNELS.meetingsRename, (_e, id: string, title: string) => {
    if (typeof id !== 'string' || typeof title !== 'string') throw new Error('invalid args');
    return s.meetings.updateTitle(id, title.slice(0, 500));
  });

  ipc.handle(IPC_CHANNELS.meetingsDelete, (_e, id: unknown): boolean => {
    if (typeof id !== 'string' || id.length === 0) throw new Error('invalid args');
    const m = s.meetings.findById(id);
    if (!m || m.deletedAt) return false; // idempotent no-op, not a new deletion
    const pipelineStatus = s.pipeline.getStatus?.();
    if (pipelineStatus ? pipelineStatus.currentId === id : m.status === 'processing') {
      throw new Error('Wait for processing to finish or cancel it before deleting this meeting.');
    }
    if (pipelineStatus?.queueIds.includes(id)) {
      s.pipeline.removeQueued?.(id);
    }
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
    return true;
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

  ipc.handle(IPC_CHANNELS.trashList, () => {
    // Purge anything past the retention window first, so the "Recently
    // deleted" section never lists a meeting whose files are already
    // gone (or about to be). Same semantics as the startup/hourly purge
    // in main/index.ts — this just runs it on demand.
    const cutoff = new Date(Date.now() - TRASH_RETENTION_MS).toISOString();
    for (const m of s.meetings.findSoftDeleted(cutoff)) {
      purgeTrashDir(s.libraryRoot, m.id);
      s.meetings.hardDelete(m.id);
      s.logger.info('trash:purged', { meetingId: m.id });
    }
    return s.meetings.findSoftDeleted()
      .sort((a, b) => (b.deletedAt ?? '').localeCompare(a.deletedAt ?? ''))
      .map((m) => ({ id: m.id, title: m.title, deletedAt: m.deletedAt }));
  });

  ipc.handle(IPC_CHANNELS.meetingsRerun, (_e, id: string, fromStage: string) => {
    const parsed = RerunSchema.parse({ id, fromStage });
    // Clear stale artifacts & DB rows for the stage we're rewinding to, so the
    // UI doesn't keep showing yesterday's bad transcript while the retry runs.
    const meeting = s.meetings.findById(parsed.id);
    if (!meeting || meeting.deletedAt) throw new Error('Meeting no longer exists');
    if (meeting.status === 'processing') throw new Error('Wait for processing to finish before restarting');
    if (shouldClearActionItems(parsed.fromStage)) s.notesHistory?.capture(parsed.id, 'Before reprocessing');
    s.meetings.recordProcessingEvent(parsed.id, 'retry', parsed.fromStage, 'User requested reprocessing; original audio retained and existing notes/action items saved to history when present.');
    if (meeting) {
      const folder = meetingFolderPath(s.libraryRoot, meeting.slug);
      const snapshot = preserveTranscript(folder, parsed.fromStage);
      if (snapshot) s.meetings.recordProcessingEvent(parsed.id, 'retry', parsed.fromStage, `Previous transcript preserved in the meeting folder: ${snapshot}`);
      clearArtifactsFromStage(folder, parsed.fromStage, s.artifactCache);
    }
    if (shouldClearActionItems(parsed.fromStage)) s.actionItems.deleteForMeeting(parsed.id);
    if (shouldClearSpeakerLinks(parsed.fromStage)) s.speakers.unlinkMeeting(parsed.id);
    s.meetings.updateStage(parsed.id, parsed.fromStage);
    // A re-run may drive the meeting back into the gate — clear so it re-alerts.
    clearGateNotified(parsed.id, s.gateNotified);
    s.meetings.updateStatus(parsed.id, 'processing');
    s.pipeline.enqueue(parsed.id);
  });

  const startOne = (id: string, pendingOnly = false): boolean => {
    if (typeof id !== 'string' || id.length === 0) return false;
    const m = s.meetings.findById(id);
    if (!m) return false;
    if (pendingOnly && (m.deletedAt || m.status !== 'pending')) return false;
    s.meetings.updateStatus(id, 'processing');
    try {
      s.pipeline.enqueue(id);
    } catch (error) {
      // Detailed bulk failures must still be eligible to retry. Preserve the
      // legacy start/startMany behavior when pendingOnly is not requested.
      if (pendingOnly) s.meetings.updateStatus(id, m.status);
      throw error;
    }
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
          remergeTranscript(id, { libraryRoot: s.libraryRoot, meetings: s.meetings, speakers: s.speakers, artifactCache: s.artifactCache, userName: s.settings.get('userName'), terminology: s.terminology });
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
      remergeTranscript(id, { libraryRoot: s.libraryRoot, meetings: s.meetings, speakers: s.speakers, artifactCache: s.artifactCache, userName: s.settings.get('userName'), terminology: s.terminology });
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
    if (s.terminology) { s.terminology.saveSummary(id, markdown); return markdown; }
    const meeting = s.meetings.findById(id);
    if (!meeting) throw new Error('meeting not found');
    const folder = meetingFolderPath(s.libraryRoot, meeting.slug);
    fs.mkdirSync(folder, { recursive: true });
    const summaryPath = path.join(folder, 'summary.md');
    s.artifactCache.invalidate(summaryPath);
    fs.writeFileSync(summaryPath, markdown);
    return markdown;
  });

  ipc.handle(IPC_CHANNELS.notesHistoryList, (_e, id: unknown) => s.notesHistory?.list(z.string().min(1).max(200).parse(id)) ?? []);
  ipc.handle(IPC_CHANNELS.notesHistoryCompare, (_e, id: unknown, version: unknown) => {
    if (!s.notesHistory) throw new Error('Notes history is unavailable');
    return s.notesHistory.compare(z.string().min(1).max(200).parse(id), z.string().uuid().parse(version));
  });
  ipc.handle(IPC_CHANNELS.notesHistoryRestore, (_e, id: unknown, version: unknown, revision: unknown) => {
    if (!s.notesHistory) throw new Error('Notes history is unavailable');
    s.notesHistory.restore(z.string().min(1).max(200).parse(id), z.string().uuid().parse(version), z.string().length(64).parse(revision));
  });

  ipc.handle(IPC_CHANNELS.meetingsStartManyDetailed, (_e, input: unknown): MeetingStartManyResult => {
    const ids = MeetingIdsSchema.parse(input);
    const result: MeetingStartManyResult = { startedIds: [], failedIds: [] };
    for (const id of ids) {
      try {
        (startOne(id, true) ? result.startedIds : result.failedIds).push(id);
      } catch {
        result.failedIds.push(id);
      }
    }
    return result;
  });
}

export function registerImportDroppedHandler(ipc: IpcMain, s: IpcServices): void {
  // Drag-and-drop import. Copies dropped audio into the library's own
  // recordings folder, which the watcher always catalogs; the optional
  // audioWatchPath is empty by default and cannot be relied on.
  ipc.handle(IPC_CHANNELS.meetingsImportDropped, async (_e, paths: unknown) => {
    const list = Array.isArray(paths) ? paths.filter((p): p is string => typeof p === 'string') : [];
    return importAudioFiles(list, recordingsDirFor(s.libraryRoot));
  });
}
