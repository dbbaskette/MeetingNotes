import fs from 'node:fs';
import path from 'node:path';
import type { StageHandler } from '../context.js';
import { meetingFolderPath } from '../../storage/meeting-folder.js';
import { embeddingForLabel, type DiarizationArtifact } from '../../speakers/sample-extractor.js';

export const runIdentifying: StageHandler = async ({ meetingId }, ctx) => {
  const meeting = ctx.meetings.findById(meetingId);
  if (!meeting) throw new Error(`meeting not found: ${meetingId}`);
  const folder = meetingFolderPath(ctx.libraryRoot, meeting.slug);
  const diar = JSON.parse(fs.readFileSync(path.join(folder, 'diarization.json'), 'utf8')) as DiarizationArtifact;
  const labels = [...new Set(diar.segments.map(s => s.speaker))];
  const detected = labels.flatMap(label => {
    const embedding = embeddingForLabel(diar, label);
    return embedding ? [{ label, embedding }] : [];
  });
  // Preserved only for this artifact: new diarization invalidates run-local links.
  const existing = new Map(ctx.speakers.listForMeeting(meetingId).map(s => [s.localLabel, s.rosterSpeakerId]));
  const matches = ctx.roster.identifyUnknowns(detected.filter(s => !existing.get(s.label)), {
    enabled: ctx.settings.get('autoMatchSpeakers') === true,
    space: diar.embeddingSpace, segments: diar.segments,
    reservedRosterIds: [...existing.values()].filter((id): id is string => !!id),
  });
  const byLabel = new Map(matches.map(m => [m.label, m]));
  for (const label of labels) {
    if (existing.get(label)) continue;
    const match = byLabel.get(label);
    ctx.speakers.linkToMeeting(meetingId, label, match?.rosterId ?? null, match?.confidence ?? 0,
      match?.rosterId ? 'automatic' : null);
  }
  ctx.logger.info('identify:done', { meetingId, matched: matches.filter(m => m.rosterId).length, total: labels.length });
};
