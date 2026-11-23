import type { IpcMain } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { IPC_CHANNELS } from './contracts.js';
import type { IpcServices } from './handlers.js';
import { VoiceProfiles } from '../speakers/voice-profiles.js';
import { resolveSpeakerLabels } from '../../shared/productivity.js';
import { meetingFolderPath } from '../storage/meeting-folder.js';
import { extractSpeakerSample, embeddingForLabel, type DiarizationArtifact } from '../speakers/sample-extractor.js';
import { remergeTranscript } from '../pipeline/stages/merging.js';
import { listMeetingSpeakers, speakerReviewForFolder } from './meeting-speakers.js';
import { calendarCandidates } from '../speakers/calendar-candidates.js';

export function registerSpeakerHandlers(ipc: IpcMain, s: IpcServices): void {
  ipc.handle(IPC_CHANNELS.speakersList, () => s.speakers.list());
  const requireSpeakerEditable = (meetingId: string): void => {
    const meeting = s.meetings.findById(meetingId);
    if (!meeting || meeting.deletedAt) throw new Error('Meeting not found');
    if (meeting.status === 'processing') throw new Error('Wait for this meeting to finish processing before changing its speakers.');
  };
  // Re-run the merge step for every meeting linked to a roster speaker, so
  // a rename/merge shows up in the transcripts, not just the roster list.
  // Yields between meetings so multi-meeting renames/merges don't freeze IPC.
  const remergeMeetings = async (meetingIds: string[]): Promise<void> => {
    for (let i = 0; i < meetingIds.length; i++) {
      if (i > 0) await new Promise<void>((resolve) => setImmediate(resolve));
      const meetingId = meetingIds[i]!;
      try {
        remergeTranscript(meetingId, {
          terminology: s.terminology,
          libraryRoot: s.libraryRoot,
          meetings: s.meetings,
          speakers: s.speakers,
          artifactCache: s.artifactCache,
          userName: s.settings.get('userName'),
        });
        const meeting = s.meetings.findById(meetingId);
        if (meeting?.status === 'done') {
          const names = Object.fromEntries(s.speakers.listForMeeting(meetingId).filter(link => link.displayName).map(link => [link.localLabel, link.displayName!]));
          const file = path.join(meetingFolderPath(s.libraryRoot, meeting.slug), 'summary.md');
          const previous = (await s.artifactCache.readText(file)) ?? '';
          const updated = resolveSpeakerLabels(previous, names);
          const changes = updated !== previous || s.actionItems.listByMeeting(meetingId).some(item => [item.text, item.ownerName, item.sourceQuote].some(value => value && resolveSpeakerLabels(value, names) !== value));
          if (changes) {
            s.notesHistory?.capture(meetingId, 'Before speaker labels resolved');
            if (updated !== previous) {
              if (s.terminology) s.terminology.saveSummary(meetingId, updated);
              else { fs.writeFileSync(file, updated); s.artifactCache.invalidate(file); }
            }
            // The notes were written with unresolved labels: the meeting page
            // offers to regenerate them with the names (#252). Cleared when
            // the notes are regenerated (meetings:rerun).
            s.meetings.markNamesChangedSinceNotes(meetingId);
          }
          // Always run: besides rewriting labels it links task owners to the
          // roster speaker their name now maps to, which "mine" relies on.
          s.actionItems.resolveLabels(meetingId, names);
        }
      } catch { /* see note above */ }
    }
  };

  ipc.handle(IPC_CHANNELS.speakersRename, async (_e, id: string, name: string) => {
    if (typeof id !== 'string' || typeof name !== 'string') throw new Error('invalid args');
    s.speakers.meetingIdsForSpeaker(id).forEach(requireSpeakerEditable);
    s.speakers.rename(id, name.slice(0, 200));
    // Push the new name into the transcripts of every meeting this speaker
    // appears in (previously the rename only touched the roster row).
    await remergeMeetings(s.speakers.meetingIdsForSpeaker(id));
  });

  ipc.handle(IPC_CHANNELS.speakersMerge, async (_e, sourceId: unknown, targetId: unknown) => {
    if (typeof sourceId !== 'string' || sourceId.length === 0
      || typeof targetId !== 'string' || targetId.length === 0) throw new Error('invalid args');
    if (sourceId === targetId) throw new Error('cannot merge a speaker into itself');
    if (!s.speakers.findById(sourceId)) throw new Error('source speaker not found');
    if (!s.speakers.findById(targetId)) throw new Error('target speaker not found');
    s.speakers.meetingIdsForSpeaker(sourceId).forEach(requireSpeakerEditable);
    let affectedMeetingIds: string[] = [];
    new VoiceProfiles(s.libraryRoot).merge(sourceId, targetId, () => { affectedMeetingIds = s.speakers.mergeSpeakers(sourceId, targetId); });
    // Keep the "You are…" pointer valid if it referenced the deleted source
    // (mirrors the startup dedupe pass in electron/main/index.ts).
    if (s.settings.get('userSpeakerId') === sourceId) s.settings.set('userSpeakerId', targetId);
    await remergeMeetings(affectedMeetingIds);
    return { affectedMeetingIds };
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
      diarization: await s.artifactCache.readJson<DiarizationArtifact>(diarPath) ?? undefined,
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
  ipc.handle(IPC_CHANNELS.speakersAssign, async (_e, input: unknown) => {
    const parsed = AssignSchema.parse(input);
    requireSpeakerEditable(parsed.meetingId);
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
      try {
        const diar = await s.artifactCache.readJson<DiarizationArtifact>(diarPath);
        const embedding = diar ? embeddingForLabel(diar, parsed.localLabel) : null;
        if (diar && embedding) s.roster.confirmSpeakerFor(parsed.rosterId, embedding, diar.embeddingSpace, `${m.title} · ${parsed.localLabel}`);
      } catch { /* roster update is best-effort; don't fail the link */ }
      s.speakers.linkToMeeting(parsed.meetingId, parsed.localLabel, parsed.rosterId, 1.0);
      await remergeMeetings([parsed.meetingId]);
      return parsed.rosterId;
    }

    // mode === 'new': derive the embedding from diarization.json so the
    // renderer never touches raw embeddings.
    if (!parsed.displayName) throw new Error('displayName required for mode=new');
    const folder = meetingFolderPath(s.libraryRoot, m.slug);
    const diarPath = path.join(folder, 'diarization.json');
    const diar = await s.artifactCache.readJson<DiarizationArtifact>(diarPath);
    if (!diar) throw new Error('diarization not available yet');
    const embedding = embeddingForLabel(diar, parsed.localLabel);
    const id = s.roster.confirmSpeaker({ displayName: parsed.displayName, embedding, source: `${m.title} · ${parsed.localLabel}` }, diar.embeddingSpace);
    s.speakers.linkToMeeting(parsed.meetingId, parsed.localLabel, id, 1.0);
    await remergeMeetings([parsed.meetingId]);
    return id;
  });

  const BulkAssignSchema = z.object({
    meetingId: z.string().min(1),
    localLabels: z.array(z.string().min(1)).min(1).max(100),
    rosterId: z.string().min(1),
  });
  ipc.handle(IPC_CHANNELS.speakersAssignBulk, async (_e, input: unknown) => {
    const parsed = BulkAssignSchema.parse(input);
    const meeting = s.meetings.findById(parsed.meetingId);
    if (!meeting) throw new Error('meeting not found');
    if (!s.speakers.findById(parsed.rosterId)) throw new Error('roster speaker not found');
    const labels = [...new Set(parsed.localLabels)];
    const folder = meetingFolderPath(s.libraryRoot, meeting.slug);
    const links = listMeetingSpeakers(s.speakers, parsed.meetingId);
    const [metadata, diarFile] = await Promise.all([
      speakerReviewForFolder(folder, links, s.artifactCache),
      s.artifactCache.readJson<DiarizationArtifact>(path.join(folder, 'diarization.json')),
    ]);
    requireSpeakerEditable(parsed.meetingId);
    for (const localLabel of labels) {
      const embedding = diarFile ? embeddingForLabel(diarFile, localLabel) : null;
      if (embedding) s.roster.confirmSpeakerFor(parsed.rosterId, embedding, diarFile?.embeddingSpace, `${meeting.title} · ${localLabel}`);
      s.speakers.linkToMeeting(parsed.meetingId, localLabel, parsed.rosterId, 1);
    }
    // Awaited so the reload that follows sees the rewritten notes and the
    // regenerate prompt (#252).
    await remergeMeetings([parsed.meetingId]);
    return {
      assigned: labels.length,
      impactedLines: labels.reduce((sum, label) => sum + (metadata.get(label)?.lineCount ?? 0), 0),
    };
  });

  ipc.handle(IPC_CHANNELS.speakersReview, async (_e, meetingId: string) => {
    const meeting = s.meetings.findById(meetingId);
    if (!meeting || meeting.deletedAt) throw new Error('Meeting not found');
    const diar = await s.artifactCache.readJson<DiarizationArtifact>(path.join(meetingFolderPath(s.libraryRoot, meeting.slug), 'diarization.json'));
    if (!diar) return [];
    const labels = [...new Set(diar.segments.map(segment => segment.speaker))];
    const detected = labels.map(label => ({ label, embedding: embeddingForLabel(diar, label) ?? [] }));
    const linked = new Map(s.speakers.listForMeeting(meetingId).map(link => [link.localLabel, link.rosterSpeakerId]));
    const matches = s.roster.identifyUnknowns(detected.filter(item => !linked.get(item.label)), { enabled: s.settings.get('autoMatchSpeakers'), space: diar.embeddingSpace, segments: diar.segments,
      reservedRosterIds: [...linked.values()].filter((id): id is string => !!id) });
    const suggestions = s.roster.suggestionsBatch(detected, diar.embeddingSpace);
    // Calendar-aware recording (#253): attendee names from the stored event,
    // offered as candidates only. Hidden while the setting is off; reading
    // the stored event calls no calendar API.
    const event = s.settings.get('calendarAware') ? s.meetings.calendarEventFor(meetingId) : null;
    const calendarSuggestions = event ? calendarCandidates({ attendees: event.attendees, roster: s.speakers.list(),
      linkedRosterIds: [...linked.values()] }) : [];
    return detected.map(item => ({ label: item.label, reason: matches.find(match => match.label === item.label)?.reason,
      suggestions: suggestions.get(item.label) ?? [], calendarSuggestions }));
  });
  ipc.handle(IPC_CHANNELS.speakersProfiles, (_e, id: string) => new VoiceProfiles(s.libraryRoot).info(id));
  ipc.handle(IPC_CHANNELS.speakersUndoProfile, (_e, id: string, space: string) => {
    if (!s.speakers.findById(id)) throw new Error('Speaker not found');
    new VoiceProfiles(s.libraryRoot).undo(space, id);
  });

  ipc.handle(IPC_CHANNELS.speakersUnlink, (_e, meetingId: unknown, localLabel: unknown) => {
    if (typeof meetingId !== 'string' || typeof localLabel !== 'string') throw new Error('invalid args');
    requireSpeakerEditable(meetingId);
    // "Unlink" removes the roster_speaker_id but keeps the meeting_speakers
    // row so the local label still shows up as an unidentified voice.
    s.speakers.linkToMeeting(meetingId, localLabel, null, 0);
    remergeMeetings([meetingId]);
  });
}
