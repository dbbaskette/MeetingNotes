import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
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
type Trim = (source: string, destination: string, endSeconds: number, startSeconds: number) => Promise<void>;

export class RecordingRecoveryService {
  private readonly busy = new Set<string>();
  private readonly probes = new Map<string, { fingerprint: string; duration: Promise<number | null>; expiresAt: number }>();
  private activeProbes = 0;
  private readonly probeWaiters: Array<() => void> = [];

  constructor(private readonly deps: {
    sessions: RecordingSessionsRepo;
    meetings: MeetingsRepo;
    probe?: Probe;
    catalog: (audioPath: string) => Promise<CatalogResult>;
    reveal: (audioPath: string) => void;
    trim?: Trim;
  }) {}

  async list(onItem?: (item: RecoveryItem, index: number) => void): Promise<RecoveryItem[]> {
    const sessions = this.deps.sessions.findRecoverable().filter(
      (session) => !this.deps.meetings.findByAudioPath(session.outputPath),
    );
    const paths = new Set(sessions.flatMap((session) => {
      const stems = deriveStemPaths(session.outputPath);
      return [session.outputPath, stems.voice, stems.system];
    }));
    for (const file of this.probes.keys()) if (!paths.has(file)) this.probes.delete(file);
    const items: RecoveryItem[] = [];
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, sessions.length) }, async () => {
      while (next < sessions.length) {
        const index = next++;
        const item = await this.inspect(sessions[index]!);
        items[index] = item;
        onItem?.(item, index);
      }
    }));
    return items;
  }

  private async probeDuration(file: string, fingerprint: string): Promise<number | null> {
    const cached = this.probes.get(file);
    if (cached?.fingerprint === fingerprint && cached.expiresAt > Date.now()) return cached.duration;
    const duration = (async () => {
      // A released slot is handed directly to its waiter, so new callers
      // cannot steal it and exceed the service-wide subprocess limit.
      if (this.activeProbes >= 4) await new Promise<void>((resolve) => this.probeWaiters.push(resolve));
      else this.activeProbes++;
      try {
        const result = await (this.deps.probe ?? probeAudio)(file);
        return Number.isFinite(result.durationS) && result.durationS > 0 ? result.durationS : null;
      } catch { return null; }
      finally {
        const waiter = this.probeWaiters.shift();
        if (waiter) waiter();
        else this.activeProbes--;
      }
    })();
    const entry = { fingerprint, duration, expiresAt: Infinity };
    this.probes.set(file, entry);
    // Invalid media and transient ffprobe failures share a null result.
    // Retry negative results after a short cooldown rather than poisoning
    // an unchanged recording for the lifetime of the application.
    void duration.then((result) => {
      if (result === null) entry.expiresAt = Date.now() + 30_000;
    });
    return duration;
  }

  async recover(id: string): Promise<{ meetingId: string }> {
    return this.exclusive(id, () => this.recoverCopy(id));
  }

  private async exclusive<T>(id: string, action: () => Promise<T>): Promise<T> {
    if (this.busy.has(id)) throw new Error('This recording is already being recovered.');
    this.busy.add(id);
    try { return await action(); } finally { this.busy.delete(id); }
  }

  private async recoverCopy(id: string): Promise<{ meetingId: string }> {
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

  async preview(id: string): Promise<{ url: string; durationS: number }> {
    const session = this.requireSession(id);
    const item = await this.inspect(session);
    if (!item.canRecover || item.durationS === null) throw new Error('No playable audio was found. Try opening the recording in Finder.');
    return { url: pathToFileURL(this.sourceFor(session, item)).href, durationS: item.durationS };
  }

  private sourceFor(session: RecordingSessionRow, item: RecoveryItem): string {
    const stems = deriveStemPaths(session.outputPath);
    return item.reason === 'microphone-only' ? stems.voice
      : item.reason === 'system-only' ? stems.system : session.outputPath;
  }

  async trim(id: string, endSeconds: number, startSeconds = 0): Promise<{ meetingId: string }> {
    return this.exclusive(id, () => this.trimCopy(id, endSeconds, startSeconds));
  }

  private async trimCopy(id: string, endSeconds: number, startSeconds: number): Promise<{ meetingId: string }> {
    if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || startSeconds < 0 || endSeconds <= startSeconds) {
      throw new Error('Choose a start at or after zero and an end after the start.');
    }
    const session = this.requireSession(id);
    const item = await this.inspect(session);
    if (!item.canTrim) throw new Error('This recording cannot be trimmed.');
    if (item.durationS === null || endSeconds > item.durationS) throw new Error('The selected range exceeds the recording duration.');
    const source = this.sourceFor(session, item);
    const destination = this.recoveredPath(session.outputPath, 'trimmed');
    const trim = this.deps.trim ?? (async (src, dest, end, start) => {
      await pExecFile(ffmpegPath(), ['-nostdin', '-n', '-ss', String(start), '-i', src, '-t', String(end - start), '-c', 'copy', dest]);
    });
    await trim(source, destination, endSeconds, startSeconds);
    const result = await this.deps.catalog(destination);
    this.deps.sessions.dismissRecovery(id);
    return { meetingId: result.meeting.id };
  }

  reveal(id: string): void {
    this.deps.reveal(this.requireSession(id).outputPath);
  }

  dismiss(id: string): void {
    if (this.busy.has(id)) throw new Error('Wait for recovery to finish before dismissing.');
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
    const stats = await Promise.all(candidates.map(async (file) => {
      try { return await fs.promises.stat(file); } catch { return null; }
    }));
    const sizes = stats.map((stat) => stat?.size ?? 0);
    const durations = await Promise.all(candidates.map(async (file, index) => {
      const stat = stats[index];
      if (!stat?.isFile() || stat.size === 0) {
        this.probes.delete(file);
        return null;
      }
      return this.probeDuration(file, `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`);
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
    return `${base}.recovered-${suffix}-${randomUUID()}${ext}`;
  }
}
