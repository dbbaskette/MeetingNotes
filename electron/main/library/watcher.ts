import chokidar from 'chokidar';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface WatcherOptions {
  path: string;
  stabilityMs?: number;
  pollMs?: number;
}

function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

export class LibraryWatcher {
  private watcher: chokidar.FSWatcher | null = null;
  private readonly listeners: Array<(p: string) => void> = [];
  private readonly stability: number;
  private readonly poll: number;
  private readonly emitted = new Set<string>();

  constructor(private readonly opts: WatcherOptions) {
    this.stability = opts.stabilityMs ?? 2000;
    this.poll = opts.pollMs ?? 500;
  }

  onStableFile(fn: (p: string) => void): void { this.listeners.push(fn); }

  async start(): Promise<void> {
    const watchPath = expandHome(this.opts.path);
    if (!fs.existsSync(watchPath)) {
      throw new Error(`watch path does not exist: ${watchPath}`);
    }
    let realWatchPath = watchPath;
    try { realWatchPath = fs.realpathSync(watchPath); } catch { /* ignore */ }

    // Explicit one-shot scan for files that already exist. chokidar's
    // ignoreInitial+awaitWriteFinish combo is flaky for static files (it polls
    // for size changes that never come), so we do this ourselves and rely on
    // chokidar only for *new* arrivals.
    try {
      for (const name of fs.readdirSync(watchPath)) {
        if (!name.toLowerCase().endsWith('.mp3')) continue;
        const full = path.join(watchPath, name);
        try {
          const st = fs.statSync(full);
          if (!st.isFile()) continue;
        } catch { continue; }
        this.emit(full);
      }
    } catch { /* unreadable dir is reported by chokidar 'error' below */ }

    // Now watch for *new* files. ignoreInitial=true so we don't double-fire
    // for the ones we just emitted; awaitWriteFinish gives Audio Hijack time
    // to finish writing before we start processing.
    this.watcher = chokidar.watch(watchPath, {
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: this.stability, pollInterval: this.poll },
    });
    await new Promise<void>((resolve) => {
      this.watcher!.once('ready', () => resolve());
    });
    this.watcher.on('add', (p) => {
      if (!p.toLowerCase().endsWith('.mp3')) return;
      // Re-root resolved paths so consumers store stable identifiers — without
      // this, a watch path that's a symlink would get its real-path version
      // into the DB and later restarts couldn't dedupe by audio_path.
      let out = p;
      if (realWatchPath !== watchPath && p.startsWith(realWatchPath)) {
        out = path.join(watchPath, p.slice(realWatchPath.length));
      }
      this.emit(out);
    });
  }

  private emit(p: string): void {
    if (this.emitted.has(p)) return;
    this.emitted.add(p);
    for (const fn of this.listeners) fn(p);
  }

  async stop(): Promise<void> {
    await this.watcher?.close();
    this.watcher = null;
  }
}
