import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import type { MeetingsRepo } from '../storage/meetings-repo.js';
import type { RecordingSessionRow, RecordingSessionsRepo } from '../storage/recording-sessions-repo.js';
import { deriveStemPaths } from '../lib/stem-paths.js';
import { ffmpegPath } from '../lib/find-ffmpeg.js';
import { probeAudio, type AudioInfo } from '../library/ffprobe.js';
import type { CatalogResult } from '../library/catalog.js';

const pExecFile = promisify(execFile);

export type RecoveryReason = 'not-indexed' | 'microphone-only' | 'system-only' | 'unreadable';
export interface RecoveryItem {
  id: string;
  targetLabel: string;
  startedAt: string;
  outputPath: string;
  status: RecordingSessionRow['status'];
  reason: RecoveryReason;
  durationS: number | null;
  sizeBytes: number;
  canRecover: boolean;
  canTrim: boolean;
}

type Probe = (file: string) => Promise<AudioInfo>;
type Trim = (source: string, destination: string, endSeconds: number) => Promise<void>;

export class RecordingRecoveryService {
  constructor(private readonly deps: {
    sessions: RecordingSessionsRepo;
    meetings: MeetingsRepo;
    probe?: Probe;
    catalog: (audioPath: string) => Promise<CatalogResult>;
    reveal: (audioPath: string) => void;
    trim?: Trim;
  }) {}

  async list(): Promise<RecoveryItem[]> {
    const items: RecoveryItem[] = [];
    for (const session of this.deps.sessions.findRecoverable()) {
      if (this.deps.meetings.findByAudioPath(session.outputPath)) continue;
      items.push(await this.inspect(session));
    }
    return items;
  }

  async recover(id: string): Promise<{ meetingId: string }> {
    const session = this.requireSession(id);
    const item = await this.inspect(session);
    if (!item.canRecover) throw new Error('This recording does not contain recoverable audio.');
    const paths = deriveStemPaths(session.outputPath);
    let source = session.outputPath;
    let destination = source;
    if (item.reason === 'microphone-only') {
      source = paths.voice;
      destination = this.recoveredPath(session.outputPath, 'mic');
    } else if (item.reason === 'system-only') {
      source = paths.system;
      destination = this.recoveredPath(session.outputPath, 'system');
    }
    if (source !== destination) fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
    const result = await this.deps.catalog(destination);
    this.deps.sessions.dismissRecovery(id);
    return { meetingId: result.meeting.id };
  }

  async trim(id: string, endSeconds: number): Promise<{ meetingId: string }> {
    if (!Number.isFinite(endSeconds) || endSeconds <= 0) throw new Error('Trim length must be positive.');
    const session = this.requireSession(id);
    const item = await this.inspect(session);
    if (!item.canTrim) throw new Error('This recording cannot be trimmed.');
    const stems = deriveStemPaths(session.outputPath);
    const source = item.reason === 'microphone-only' ? stems.voice
      : item.reason === 'system-only' ? stems.system : session.outputPath;
    const destination = this.recoveredPath(session.outputPath, 'trimmed');
    const trim = this.deps.trim ?? (async (src, dest, end) => {
      await pExecFile(ffmpegPath(), ['-y', '-i', src, '-t', String(end), '-c', 'copy', dest]);
    });
    await trim(source, destination, Math.min(endSeconds, item.durationS ?? endSeconds));
    const result = await this.deps.catalog(destination);
    this.deps.sessions.dismissRecovery(id);
    return { meetingId: result.meeting.id };
  }

  reveal(id: string): void {
    this.deps.reveal(this.requireSession(id).outputPath);
  }

  dismiss(id: string): void {
    this.requireSession(id);
    this.deps.sessions.dismissRecovery(id);
  }

  private requireSession(id: string): RecordingSessionRow {
    const session = this.deps.sessions.findById(id);
    if (!session || session.dismissedAt) throw new Error('Recovery item not found.');
    return session;
  }

  private async inspect(session: RecordingSessionRow): Promise<RecoveryItem> {
    const stems = deriveStemPaths(session.outputPath);
    const candidates = [session.outputPath, stems.voice, stems.system];
    const sizes = candidates.map((file) => {
      try { return fs.statSync(file).size; } catch { return 0; }
    });
    const durations = await Promise.all(candidates.map(async (file) => {
      if (!fs.existsSync(file) || sizes[candidates.indexOf(file)] === 0) return null;
      try {
        const result = await (this.deps.probe ?? probeAudio)(file);
        return Number.isFinite(result.durationS) && result.durationS > 0 ? result.durationS : null;
      } catch { return null; }
    }));
    const [primaryDuration, voiceDuration, systemDuration] = durations;
    const reason: RecoveryReason = primaryDuration ? 'not-indexed'
      : voiceDuration ? 'microphone-only'
        : systemDuration ? 'system-only' : 'unreadable';
    const durationS = primaryDuration ?? voiceDuration ?? systemDuration ?? null;
    return {
      id: session.id, targetLabel: session.targetLabel, startedAt: session.startedAt,
      outputPath: session.outputPath, status: session.status, reason, durationS,
      sizeBytes: sizes.reduce((sum, size) => sum + size, 0),
      canRecover: durationS !== null, canTrim: durationS !== null && durationS > 1,
    };
  }

  private recoveredPath(original: string, suffix: string): string {
    const ext = path.extname(original) || '.m4a';
    const base = original.slice(0, original.length - path.extname(original).length);
    let candidate = `${base}.recovered-${suffix}${ext}`;
    if (fs.existsSync(candidate)) candidate = `${base}.recovered-${suffix}-${Date.now()}${ext}`;
    return candidate;
  }
}
