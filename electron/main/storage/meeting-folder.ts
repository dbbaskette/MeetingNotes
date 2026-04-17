import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

export const MeetingRecordSchema = z.object({
  id: z.string(),
  slug: z.string(),
  title: z.string(),
  startedAt: z.string().nullable(),
  durationS: z.number().nullable(),
  audioPath: z.string(),
  pipelineStage: z.string(),
  speakers: z.array(z.object({
    label: z.string(),
    rosterId: z.string().nullable(),
    confidence: z.number().nullable(),
  })),
  models: z.record(z.string(), z.string()),
});
export type MeetingRecord = z.infer<typeof MeetingRecordSchema>;

export function meetingFolderPath(root: string, slug: string): string {
  return path.join(root, 'meetings', slug);
}

export function createMeetingFolder(root: string, slug: string, audioPath: string): string {
  const folder = meetingFolderPath(root, slug);
  fs.mkdirSync(folder, { recursive: true });
  fs.mkdirSync(path.join(folder, 'exports'), { recursive: true });
  const link = path.join(folder, 'audio.mp3');
  if (!fs.existsSync(link)) fs.symlinkSync(audioPath, link);
  return folder;
}

export function writeMeetingJson(folder: string, rec: MeetingRecord): void {
  fs.writeFileSync(path.join(folder, 'meeting.json'), JSON.stringify(rec, null, 2));
}

export function readMeetingJson(folder: string): MeetingRecord {
  const raw = fs.readFileSync(path.join(folder, 'meeting.json'), 'utf8');
  return MeetingRecordSchema.parse(JSON.parse(raw));
}
