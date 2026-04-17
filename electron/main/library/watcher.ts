import chokidar from 'chokidar';
import fs from 'node:fs';
import path from 'node:path';

export interface WatcherOptions {
  path: string;
  stabilityMs?: number;
  pollMs?: number;
}

export class LibraryWatcher {
  private watcher: chokidar.FSWatcher | null = null;
  private readonly listeners: Array<(p: string) => void> = [];
  private readonly stability: number;
  private readonly poll: number;

  constructor(private readonly opts: WatcherOptions) {
    this.stability = opts.stabilityMs ?? 2000;
    this.poll = opts.pollMs ?? 500;
  }

  onStableFile(fn: (p: string) => void): void { this.listeners.push(fn); }

  async start(): Promise<void> {
    const watchPath = this.opts.path;
    let realWatchPath = watchPath;
    try { realWatchPath = fs.realpathSync(watchPath); } catch { /* ignore */ }
    this.watcher = chokidar.watch(watchPath, {
      ignoreInitial: true,
      persistent: true,
      usePolling: true,
      interval: this.poll,
      awaitWriteFinish: { stabilityThreshold: this.stability, pollInterval: this.poll },
    });
    await new Promise<void>((resolve) => {
      this.watcher!.once('ready', () => resolve());
    });
    this.watcher.on('add', (p) => {
      if (!p.toLowerCase().endsWith('.mp3')) return;
      try { fs.accessSync(p); } catch { return; }
      // Map chokidar's resolved (realpath) output back to the caller-supplied path
      // so consumers get paths rooted at the directory they passed in.
      let out = p;
      if (realWatchPath !== watchPath && p.startsWith(realWatchPath)) {
        out = path.join(watchPath, p.slice(realWatchPath.length));
      }
      for (const fn of this.listeners) fn(out);
    });
  }

  async stop(): Promise<void> {
    await this.watcher?.close();
    this.watcher = null;
  }
}
