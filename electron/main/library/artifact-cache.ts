import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

export interface ArtifactCacheFileStat {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

export interface ArtifactCacheOptions {
  maxBytes?: number;
  stat?: (filePath: string) => Promise<ArtifactCacheFileStat>;
  readFile?: (filePath: string) => Promise<string>;
}

export interface ArtifactCacheStats {
  entries: number;
  bytes: number;
  retainedBytes: number;
  hits: number;
  misses: number;
  reads: number;
  inFlight: number;
}

interface CacheEntry {
  fingerprint: string | null;
  generation: string;
  source: string | null;
  bytes: number;
  lastUsed: number;
  inFlight?: Promise<string | null>;
}

/** Process-local cache for text artifacts whose source of truth is on disk. */
export class ArtifactCache {
  private readonly maxBytes: number;
  private readonly statFile: (filePath: string) => Promise<ArtifactCacheFileStat>;
  private readonly readFile: (filePath: string) => Promise<string>;
  private readonly entries = new Map<string, CacheEntry>();
  private readonly pathGenerations = new Map<string, number>();
  private readonly folderGenerations = new Map<string, number>();
  private retainedBytes = 0;
  private clock = 0;
  private hitCount = 0;
  private missCount = 0;
  private readCount = 0;

  constructor(options: ArtifactCacheOptions = {}) {
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.statFile = options.stat ?? (async (filePath) => fs.stat(filePath));
    this.readFile = options.readFile ?? (async (filePath) => fs.readFile(filePath, 'utf8'));
  }

  async readText(filePath: string): Promise<string | null> {
    return this.readSource(filePath);
  }

  async readJson<T>(filePath: string): Promise<T | null> {
    const key = path.resolve(filePath);
    const source = await this.readSource(key);
    if (source === null) return null;
    try {
      return JSON.parse(source) as T;
    } catch (error) {
      // Drop the malformed source without evicting a newer, different read.
      if (this.entries.get(key)?.source === source) this.removeEntry(key);
      throw error;
    }
  }

  invalidate(filePath: string): void {
    const key = path.resolve(filePath);
    this.pathGenerations.set(key, (this.pathGenerations.get(key) ?? 0) + 1);
    this.removeEntry(key);
  }

  invalidateFolder(folder: string): void {
    const key = path.resolve(folder);
    this.folderGenerations.set(key, (this.folderGenerations.get(key) ?? 0) + 1);
    for (const entryPath of this.entries.keys()) {
      if (isWithin(entryPath, key)) this.removeEntry(entryPath);
    }
  }

  stats(): ArtifactCacheStats {
    let inFlight = 0;
    for (const entry of this.entries.values()) {
      if (entry.inFlight) inFlight++;
    }
    return {
      entries: this.entries.size,
      bytes: this.retainedBytes,
      retainedBytes: this.retainedBytes,
      hits: this.hitCount,
      misses: this.missCount,
      reads: this.readCount,
      inFlight,
    };
  }

  private async readSource(filePath: string): Promise<string | null> {
    const key = path.resolve(filePath);
    const fingerprint = await this.fingerprint(key);
    const generation = this.generationFor(key);
    const current = this.entries.get(key);

    if (current && current.fingerprint === fingerprint && current.generation === generation) {
      this.hitCount++;
      current.lastUsed = ++this.clock;
      return current.inFlight ?? current.source;
    }

    this.missCount++;
    if (current) this.removeEntry(key);

    const entry: CacheEntry = {
      fingerprint,
      generation,
      source: null,
      bytes: 0,
      lastUsed: ++this.clock,
    };
    // Register before loading, including paths that settle without any I/O.
    const inFlight = Promise.resolve().then(() => this.load(key, entry));
    entry.inFlight = inFlight;
    this.entries.set(key, entry);
    return inFlight;
  }

  private async load(key: string, entry: CacheEntry): Promise<string | null> {
    let source: string | null = null;
    if (entry.fingerprint !== null) {
      this.readCount++;
      try {
        source = await this.readFile(key);
      } catch (error) {
        if (!isMissingFile(error)) {
          if (this.entries.get(key) === entry) this.removeEntry(key);
          throw error;
        }
        // The file disappeared after stat; do not retain the successful fingerprint.
        entry.fingerprint = null;
      }
    }

    if (
      this.entries.get(key) === entry
      && entry.generation === this.generationFor(key)
    ) {
      entry.inFlight = undefined;
      entry.source = source;
      entry.bytes = source === null ? 0 : Buffer.byteLength(source);
      entry.lastUsed = ++this.clock;
      this.retainedBytes += entry.bytes;
      this.evict();
    }
    return source;
  }

  private async fingerprint(filePath: string): Promise<string | null> {
    try {
      const stat = await this.statFile(filePath);
      return `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    } catch (error) {
      if (isMissingFile(error)) return null;
      throw error;
    }
  }

  private generationFor(filePath: string): string {
    const folders = [...this.folderGenerations.entries()]
      .filter(([folder]) => isWithin(filePath, folder))
      .sort(([left], [right]) => left.localeCompare(right));
    const folderGeneration = folders.map(([folder, generation]) => `${folder}:${generation}`).join('|');
    return `${this.pathGenerations.get(filePath) ?? 0}|${folderGeneration}`;
  }

  private removeEntry(filePath: string): void {
    const entry = this.entries.get(filePath);
    if (!entry) return;
    this.entries.delete(filePath);
    this.retainedBytes -= entry.bytes;
  }

  private evict(): void {
    while (this.retainedBytes > this.maxBytes) {
      let oldestPath: string | undefined;
      let oldestEntry: CacheEntry | undefined;
      for (const [entryPath, entry] of this.entries) {
        if (entry.inFlight) continue;
        if (!oldestEntry || entry.lastUsed < oldestEntry.lastUsed) {
          oldestPath = entryPath;
          oldestEntry = entry;
        }
      }
      if (!oldestPath || !oldestEntry) return;
      this.removeEntry(oldestPath);
    }
  }
}

function isWithin(filePath: string, folder: string): boolean {
  return filePath === folder || filePath.startsWith(`${folder}${path.sep}`);
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
