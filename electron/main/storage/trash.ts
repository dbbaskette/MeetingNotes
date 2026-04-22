// electron/main/storage/trash.ts
//
// Soft-delete limbo for meetings (UX rec #2). When the user clicks
// Delete, we don't immediately `rm -rf` the audio and meeting folder —
// we move them to a per-meeting directory under `<libraryRoot>/.trash/`
// and mark the row `deleted_at` in SQLite. The toast in the renderer
// gives the user an Undo window; clicking Undo moves the files back and
// clears `deleted_at`. A periodic purge job in the main process
// hard-deletes any entry whose `deleted_at` is older than the undo
// window.
//
// Layout:
//   <libraryRoot>/.trash/<meetingId>/
//     manifest.json                — original paths so restore can undo
//     <original audio filename>    — mixed m4a
//     <original audio>.voice.m4a   — voice stem (if present)
//     <original audio>.system.m4a  — system stem (if present)
//     meeting-folder/              — the whole slug dir (transcripts etc.)

import fs from 'node:fs';
import path from 'node:path';
import { meetingFolderPath } from './meeting-folder.js';

export interface TrashManifest {
  meetingId: string;
  originalAudioPath: string;
  originalStems: { voice?: string; system?: string };
  originalMeetingFolder: string;
  trashedAt: string;
}

/** Undo window in milliseconds. Balances "long enough to click Undo" with
 *  "short enough to feel ephemeral" — 90s is the toast + a bit of slack
 *  for users who switch apps while reading it. Main process enforces via
 *  purgeExpired on startup + a 60s setInterval. */
export const UNDO_WINDOW_MS = 90_000;

/** Path to the per-meeting trash directory. */
export function trashDirForMeeting(libraryRoot: string, meetingId: string): string {
  return path.join(libraryRoot, '.trash', meetingId);
}

/** Move a meeting's files into the trash dir and write a manifest so
 *  restore() can undo without needing the DB row intact. Best-effort per
 *  file: if a stem is missing, it's not in the manifest and the restore
 *  is still correct. */
export function moveToTrash(params: {
  libraryRoot: string;
  meetingId: string;
  audioPath: string;
  slug: string;
}): TrashManifest {
  const { libraryRoot, meetingId, audioPath, slug } = params;
  const trashDir = trashDirForMeeting(libraryRoot, meetingId);
  fs.mkdirSync(trashDir, { recursive: true });

  const ext = path.extname(audioPath);
  const base = ext ? audioPath.slice(0, -ext.length) : audioPath;
  const voicePath = `${base}.voice${ext}`;
  const systemPath = `${base}.system${ext}`;

  const manifest: TrashManifest = {
    meetingId,
    originalAudioPath: audioPath,
    originalStems: {},
    originalMeetingFolder: meetingFolderPath(libraryRoot, slug),
    trashedAt: new Date().toISOString(),
  };

  const moveIfExists = (from: string, toName: string): string | undefined => {
    if (!fs.existsSync(from)) return undefined;
    const to = path.join(trashDir, toName);
    try { fs.renameSync(from, to); return from; }
    catch {
      // Cross-device link error — fall back to copy + unlink.
      try { fs.copyFileSync(from, to); fs.unlinkSync(from); return from; }
      catch { return undefined; }
    }
  };

  moveIfExists(audioPath, path.basename(audioPath));
  const voiceMoved = moveIfExists(voicePath, path.basename(voicePath));
  if (voiceMoved) manifest.originalStems.voice = voiceMoved;
  const systemMoved = moveIfExists(systemPath, path.basename(systemPath));
  if (systemMoved) manifest.originalStems.system = systemMoved;

  // Meeting folder: same rename trick.
  const meetingFolder = meetingFolderPath(libraryRoot, slug);
  if (fs.existsSync(meetingFolder)) {
    const trashedFolder = path.join(trashDir, 'meeting-folder');
    try { fs.renameSync(meetingFolder, trashedFolder); }
    catch {
      // Unlikely but possible with symlink-riddled slugs — walk it.
      fs.cpSync(meetingFolder, trashedFolder, { recursive: true });
      fs.rmSync(meetingFolder, { recursive: true, force: true });
    }
  }

  fs.writeFileSync(path.join(trashDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

/** Move a meeting's files out of the trash, back to their original
 *  locations. Returns true on success, false if the trash dir / manifest
 *  is missing (the purge already ran or the user nuked it manually). */
export function restoreFromTrash(libraryRoot: string, meetingId: string): boolean {
  const trashDir = trashDirForMeeting(libraryRoot, meetingId);
  const manifestPath = path.join(trashDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) return false;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as TrashManifest;

  const moveBack = (toPath: string, fromName: string): void => {
    const from = path.join(trashDir, fromName);
    if (!fs.existsSync(from)) return;
    fs.mkdirSync(path.dirname(toPath), { recursive: true });
    try { fs.renameSync(from, toPath); }
    catch {
      fs.copyFileSync(from, toPath);
      fs.unlinkSync(from);
    }
  };

  moveBack(manifest.originalAudioPath, path.basename(manifest.originalAudioPath));
  if (manifest.originalStems.voice)
    moveBack(manifest.originalStems.voice, path.basename(manifest.originalStems.voice));
  if (manifest.originalStems.system)
    moveBack(manifest.originalStems.system, path.basename(manifest.originalStems.system));

  const trashedFolder = path.join(trashDir, 'meeting-folder');
  if (fs.existsSync(trashedFolder)) {
    try { fs.renameSync(trashedFolder, manifest.originalMeetingFolder); }
    catch {
      fs.cpSync(trashedFolder, manifest.originalMeetingFolder, { recursive: true });
      fs.rmSync(trashedFolder, { recursive: true, force: true });
    }
  }

  try { fs.rmSync(trashDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  return true;
}

/** Hard-delete a trashed meeting's files. Called by the purge job after
 *  the undo window expires. Safe to call even if the trash dir is
 *  already gone. */
export function purgeTrashDir(libraryRoot: string, meetingId: string): void {
  const trashDir = trashDirForMeeting(libraryRoot, meetingId);
  try { fs.rmSync(trashDir, { recursive: true, force: true }); } catch { /* best-effort */ }
}
