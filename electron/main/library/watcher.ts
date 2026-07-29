import chokidar from 'chokidar';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface WatcherOptions {
  /** A single watch path, or an array. Both new (.m4a from helper) and legacy
   *  (.mp3 from Audio Hijack) folders may be configured simultaneously. */
  path?: string;
  paths?: string[];
  stabilityMs?: number;
  pollMs?: number;
  /** Test/runtime escape hatch for environments where native filesystem
   *  events are unavailable. Production keeps chokidar's native default. */
  usePolling?: boolean;
}

const SUPPORTED_EXT = /\.(mp3|m4a)$/i;

// The dual-stem capture path (issue #13) writes sidecar files
// `<base>.voice.m4a` and `<base>.system.m4a` alongside the mixed `.m4a`.
// Skip them — only the mixed file should become a meeting. The stems are
// artifacts consumed by later pipeline stages (or left on disk for the
// future stem-aware transcriber).
const STEM_SUFFIX = /\.(voice|system)\.(mp3|m4a)$/i;
function isStemArtifact(name: string): boolean {
  return STEM_SUFFIX.test(name);
}

function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

export class LibraryWatcher {
  private watchers: chokidar.FSWatcher[] = [];
  private readonly listeners: Array<(p: string) => void> = [];
  private readonly stability: number;
  private readonly poll: number;
  private readonly emitted = new Set<string>();

  constructor(private readonly opts: WatcherOptions) {
    this.stability = opts.stabilityMs ?? 2000;
    this.poll = opts.pollMs ?? 500;
  }

  onStableFile(fn: (p: string) => void): void { this.listeners.push(fn); }

  /** Make a previously delivered path eligible for a future stable change.
   *  The library calls this when probing/cataloging fails because a recorder
   *  may have paused writes before its M4A metadata was finalized. */
  release(p: string): void {
    this.emitted.delete(p);
  }

  async start(): Promise<void> {
    const rawPaths = this.opts.paths ?? (this.opts.path ? [this.opts.path] : []);
    if (rawPaths.length === 0) throw new Error('LibraryWatcher requires `path` or `paths`');
    for (const raw of rawPaths) await this.startOne(raw);
  }

  private async startOne(raw: string): Promise<void> {
    const watchPath = expandHome(raw);
    if (!fs.existsSync(watchPath)) {
      // Skip non-existent paths instead of failing the whole watcher — the
      // legacy Audio Hijack folder is optional, and users without AH installed
      // shouldn't see a startup error.
      return;
    }
    let realWatchPath = watchPath;
    try { realWatchPath = fs.realpathSync(watchPath); } catch { /* ignore */ }

    // Explicit one-shot scan for files that already exist. chokidar's
    // ignoreInitial+awaitWriteFinish combo is flaky for static files (it polls
    // for size changes that never come), so we do this ourselves and rely on
    // chokidar only for *new* arrivals.
    try {
      for (const name of fs.readdirSync(watchPath)) {
        if (!SUPPORTED_EXT.test(name) || isStemArtifact(name)) continue;
        const full = path.join(watchPath, name);
        try {
          const st = fs.statSync(full);
          if (!st.isFile()) continue;
        } catch { continue; }
        this.emit(full);
      }
    } catch { /* unreadable dir is reported by chokidar 'error' below */ }

    // Now watch for *new* files. ignoreInitial=true so we don't double-fire
    // for the ones we just emitted; awaitWriteFinish gives the recorder time
    // to finish writing before we start processing.
    const watcher = chokidar.watch(watchPath, {
      ignoreInitial: true,
      persistent: true,
      usePolling: this.opts.usePolling,
      awaitWriteFinish: { stabilityThreshold: this.stability, pollInterval: this.poll },
    });
    await new Promise<void>((resolve) => {
      watcher.once('ready', () => resolve());
    });
    const handleAudioEvent = (p: string): void => {
      if (!SUPPORTED_EXT.test(p) || isStemArtifact(p)) return;
      // Re-root resolved paths so consumers store stable identifiers — without
      // this, a watch path that's a symlink would get its real-path version
      // into the DB and later restarts couldn't dedupe by audio_path.
      let out = p;
      if (realWatchPath !== watchPath && p.startsWith(realWatchPath)) {
        out = path.join(watchPath, p.slice(realWatchPath.length));
      }
      this.emit(out);
    };
    watcher.on('add', handleAudioEvent);
    // A recorder can stop appending samples while keeping the M4A open. The
    // first stable add then fails ffprobe (no moov atom); helper finalization
    // changes the file later and must get another delivery after release().
    watcher.on('change', handleAudioEvent);
    this.watchers.push(watcher);
  }

  private emit(p: string): void {
    if (this.emitted.has(p)) return;
    this.emitted.add(p);
    for (const fn of this.listeners) fn(p);
  }

  async stop(): Promise<void> {
    await Promise.all(this.watchers.map((w) => w.close()));
    this.watchers = [];
  }
}
