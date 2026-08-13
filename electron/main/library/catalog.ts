import type { MeetingsRepo } from '../storage/meetings-repo.js';
import { createMeetingFolder } from '../storage/meeting-folder.js';
import { makeSlug, shortId } from '../lib/slug.js';
import { parseAudioHijackFilename } from '../lib/title-from-filename.js';
import { probeAudio } from './ffprobe.js';

export interface CatalogMeeting {
  id: string;
  audioPath: string;
  status: string;
  durationS: number | null;
}

export type CatalogResult =
  | { kind: 'added'; meeting: CatalogMeeting }
  | { kind: 'existing'; meeting: CatalogMeeting };

export async function catalogAudio(audioPath: string, deps: {
  meetings: MeetingsRepo;
  libraryRoot: string;
  probe?: typeof probeAudio;
  createFolder?: typeof createMeetingFolder;
  id?: () => string;
  onSlugCollision?: (slug: string, attempt: number) => void;
}): Promise<CatalogResult> {
  const existing = deps.meetings.findByAudioPath(audioPath);
  if (existing) return { kind: 'existing', meeting: existing };

  const info = await (deps.probe ?? probeAudio)(audioPath);
  const parsed = parseAudioHijackFilename(audioPath);
  const dateIso = parsed.startedAtIso?.slice(0, 10) ?? new Date().toISOString().slice(0, 10);
  const createFolder = deps.createFolder ?? createMeetingFolder;
  const makeId = deps.id ?? shortId;
  for (let attempt = 0; attempt < 5; attempt++) {
    const id = makeId();
    const slug = makeSlug(dateIso, parsed.autoTitle, id);
    try {
      createFolder(deps.libraryRoot, slug, audioPath);
      const meeting = {
        id, slug, title: parsed.autoTitle, startedAt: parsed.startedAtIso,
        durationS: info.durationS, audioPath, status: 'pending', pipelineStage: 'discovered',
      };
      deps.meetings.insert(meeting);
      return { kind: 'added', meeting };
    } catch (error) {
      if (!String(error).includes('UNIQUE')) throw error;
      deps.onSlugCollision?.(slug, attempt);
    }
  }
  throw new Error('slug collision retry exhausted');
}
