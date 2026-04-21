// electron/main/pipeline/stages/identifying.ts
import fs from 'node:fs';
import path from 'node:path';
import type { StageHandler } from '../context.js';
import { meetingFolderPath } from '../../storage/meeting-folder.js';
import { normalize } from '../../lib/cosine.js';

export const runIdentifying: StageHandler = async ({ meetingId }, ctx) => {
  const meeting = ctx.meetings.findById(meetingId);
  if (!meeting) throw new Error(`meeting not found: ${meetingId}`);
  const folder = meetingFolderPath(ctx.libraryRoot, meeting.slug);
  const diar = JSON.parse(fs.readFileSync(path.join(folder, 'diarization.json'), 'utf8'));

  // Average embedding per speaker label.
  const byLabel: Record<string, { sum: number[]; count: number }> = {};
  for (const s of diar.segments as { speaker: string; embedding: number[] }[]) {
    if (!byLabel[s.speaker]) byLabel[s.speaker] = { sum: s.embedding.slice(), count: 1 };
    else {
      const entry = byLabel[s.speaker]!;
      for (let i = 0; i < s.embedding.length; i++)
        entry.sum[i] = (entry.sum[i] ?? 0) + s.embedding[i]!;
      entry.count += 1;
    }
  }
  // Average then L2-normalize so cosine matching weighs each speaker equally
  // regardless of how many short segments they had.
  const detected = Object.entries(byLabel).map(([label, { sum, count }]) => ({
    label,
    embedding: normalize(sum.map((x) => x / count)),
  }));

  const matches = ctx.roster.identifyUnknowns(detected);
  // Preserve user assignments across re-runs. If the user already linked
  // SPEAKER_02 to "Alice" via the Speakers panel, running identify again
  // (e.g. on a rerun from `merging`) must not overwrite that assignment
  // with the auto-matcher's opinion — the user's manual label is always
  // the source of truth. We skip any label that already has a non-null
  // roster link. Unlinked labels still get the auto-match treatment.
  const existing = new Map<string, string | null>(
    ctx.speakers.listForMeeting(meetingId).map((s) => [s.localLabel, s.rosterSpeakerId]),
  );
  for (const m of matches) {
    if (existing.get(m.label)) continue; // user already identified this voice
    ctx.speakers.linkToMeeting(
      meetingId,
      m.label,
      m.rosterId ?? null,
      m.confidence ?? 0,
    );
  }
  ctx.logger.info('identify:done', {
    meetingId,
    matched: matches.filter((m) => m.rosterId).length,
    total: matches.length,
  });
};
