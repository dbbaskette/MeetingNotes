import { afterEach, describe, expect, it } from 'vitest';
import { ArtifactCache } from './artifact-cache.js';

type FakeFile = {
  content: string;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
};

const files = new Map<string, FakeFile>();
const stats = new Map<string, FakeFile>();
const reads = new Map<string, number>();

afterEach(() => {
  files.clear();
  stats.clear();
  reads.clear();
});

function put(path: string, content: string, times = 1): void {
  const file = { content, size: Buffer.byteLength(content), mtimeMs: times, ctimeMs: times };
  files.set(path, file);
  stats.set(path, file);
}

function makeCache(options: ConstructorParameters<typeof ArtifactCache>[0] = {}) {
  const readFile = options.readFile ?? (async (path: string) => {
    reads.set(path, (reads.get(path) ?? 0) + 1);
    const file = files.get(path);
    if (!file) throw new Error('ENOENT');
    return file.content;
  });
  return new ArtifactCache({
    ...options,
    stat: async (path: string) => {
      const file = stats.get(path);
      if (!file) throw new Error('ENOENT');
      return file;
    },
    readFile,
  });
}

describe('ArtifactCache', () => {
  it('shares one injected read operation for concurrent reads', async () => {
    const file = '/library/summary.md';
    put(file, 'summary');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const cache = makeCache({
      readFile: async (path: string) => {
        reads.set(path, (reads.get(path) ?? 0) + 1);
        await gate;
        return files.get(path)!.content;
      },
    });

    const first = cache.readText(file);
    const second = cache.readText(file);
    release();
    await expect(Promise.all([first, second])).resolves.toEqual(['summary', 'summary']);
    expect(reads.get(file)).toBe(1);
  });

  it('hits the cache when a fingerprint is unchanged', async () => {
    const file = '/library/summary.md';
    put(file, 'summary');
    const cache = makeCache();

    await expect(cache.readText(file)).resolves.toBe('summary');
    await expect(cache.readText(file)).resolves.toBe('summary');
    expect(reads.get(file)).toBe(1);
    expect(cache.stats().hits).toBe(1);
  });

  it('reloads when size, modification time, or change time changes', async () => {
    const file = '/library/summary.md';
    put(file, 'one', 1);
    const cache = makeCache();
    await expect(cache.readText(file)).resolves.toBe('one');

    files.set(file, { content: 'two', size: 3, mtimeMs: 2, ctimeMs: 1 });
    stats.set(file, files.get(file)!);
    await expect(cache.readText(file)).resolves.toBe('two');

    files.set(file, { content: 'three', size: 5, mtimeMs: 2, ctimeMs: 3 });
    stats.set(file, files.get(file)!);
    await expect(cache.readText(file)).resolves.toBe('three');
    expect(reads.get(file)).toBe(3);
  });

  it('invalidates missing-to-created and created-to-missing transitions', async () => {
    const file = '/library/summary.md';
    const cache = makeCache();

    await expect(cache.readText(file)).resolves.toBeNull();
    put(file, 'created', 2);
    await expect(cache.readText(file)).resolves.toBe('created');
    stats.delete(file);
    files.delete(file);
    await expect(cache.readText(file)).resolves.toBeNull();
    expect(reads.get(file)).toBe(1);
  });

  it('reloads after explicit path and folder invalidation', async () => {
    const folder = '/library/meeting-a';
    const summary = `${folder}/summary.md`;
    const transcript = `${folder}/transcript.md`;
    put(summary, 'old summary');
    put(transcript, 'old transcript');
    const cache = makeCache();

    await cache.readText(summary);
    await cache.readText(transcript);
    put(summary, 'new summary', 1);
    put(transcript, 'new transcript', 1);
    cache.invalidate(summary);
    await expect(cache.readText(summary)).resolves.toBe('new summary');
    cache.invalidateFolder(folder);
    await expect(cache.readText(transcript)).resolves.toBe('new transcript');
    expect(reads.get(summary)).toBe(2);
    expect(reads.get(transcript)).toBe(2);
  });

  it('does not let an invalidated in-flight read repopulate the cache', async () => {
    const file = '/library/summary.md';
    put(file, 'old', 1);
    let releaseOld!: () => void;
    const oldRead = new Promise<void>((resolve) => { releaseOld = resolve; });
    let first = true;
    const cache = makeCache({
      readFile: async (path: string) => {
        reads.set(path, (reads.get(path) ?? 0) + 1);
        if (first) {
          first = false;
          await oldRead;
          return 'old';
        }
        return files.get(path)!.content;
      },
    });

    const stale = cache.readText(file);
    cache.invalidate(file);
    put(file, 'new', 2);
    await expect(cache.readText(file)).resolves.toBe('new');
    releaseOld();
    await expect(stale).resolves.toBe('old');
    await expect(cache.readText(file)).resolves.toBe('new');
    expect(reads.get(file)).toBe(2);
  });

  it('fences an invalidated in-flight folder read', async () => {
    const folder = '/library/meeting-a';
    const file = `${folder}/summary.md`;
    put(file, 'old', 1);
    let releaseOld!: () => void;
    const oldRead = new Promise<void>((resolve) => { releaseOld = resolve; });
    let first = true;
    const cache = makeCache({
      readFile: async (path: string) => {
        reads.set(path, (reads.get(path) ?? 0) + 1);
        if (first) {
          first = false;
          await oldRead;
          return 'old';
        }
        return files.get(path)!.content;
      },
    });

    const stale = cache.readText(file);
    cache.invalidateFolder(folder);
    put(file, 'new', 2);
    await expect(cache.readText(file)).resolves.toBe('new');
    releaseOld();
    await stale;
    await expect(cache.readText(file)).resolves.toBe('new');
    expect(reads.get(file)).toBe(2);
  });

  it('parses JSON only for readJson and returns null for malformed JSON', async () => {
    const file = '/library/diarization.json';
    put(file, '{"speaker":"A"}');
    const cache = makeCache();

    await expect(cache.readJson<{ speaker: string }>(file)).resolves.toEqual({ speaker: 'A' });
    expect(reads.get(file)).toBe(1);
    put(file, 'not json', 2);
    await expect(cache.readJson(file)).resolves.toBeNull();
  });

  it('evicts settled least-recently-used entries over the injected byte budget', async () => {
    const first = '/library/first.md';
    const second = '/library/second.md';
    put(first, '12345');
    put(second, '67890');
    const cache = makeCache({ maxBytes: 5 });

    await cache.readText(first);
    await cache.readText(second);
    expect(cache.stats().bytes).toBe(5);
    await cache.readText(first);
    expect(reads.get(first)).toBe(2);
    expect(reads.get(second)).toBe(1);
  });
});
