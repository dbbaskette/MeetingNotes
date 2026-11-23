import path from 'node:path';
import type { SpeakersRepo } from '../storage/speakers-repo.js';
import type { ArtifactCache } from '../library/artifact-cache.js';
import type { DiarizationSegment } from '../speakers/sample-extractor.js';
import { buildSpeakerReviewMetadata, type SpeakerReviewMetadata } from '../speakers/review-metadata.js';

// Speaker-link helpers shared by the meeting and speaker IPC handlers.

export function listMeetingSpeakers(
  speakers: SpeakersRepo,
  meetingId: string,
): { localLabel: string; rosterId: string | null; displayName: string | null; confidence: number | null; assignmentSource?: 'automatic' | 'manual' | null }[] {
  return speakers.listForMeeting(meetingId).map((s) => ({
    localLabel: s.localLabel,
    rosterId: s.rosterSpeakerId,
    displayName: s.displayName,
    confidence: s.confidence,
    assignmentSource: s.assignmentSource,
  }));
}

export function unidentifiedCount(rows: { rosterId: string | null }[]): number {
  return rows.filter((r) => r.rosterId === null).length;
}

export async function speakerReviewForFolder(
  folder: string,
  links: ReturnType<typeof listMeetingSpeakers>,
  artifactCache: ArtifactCache,
): Promise<Map<string, SpeakerReviewMetadata>> {
  const [diar, raw] = await Promise.all([
    artifactCache.readJson<{ segments?: DiarizationSegment[] }>(path.join(folder, 'diarization.json')),
    artifactCache.readJson<{ segments?: Array<{ start: number; end: number; text: string; source?: 'voice' | 'system' }> }>(
      path.join(folder, 'transcript.raw.json'),
    ),
  ]);
  return buildSpeakerReviewMetadata({
    links, diarization: diar?.segments ?? [], transcript: raw?.segments ?? [],
  });
}
