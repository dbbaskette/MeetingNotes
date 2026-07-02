import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { recordingsDirFor, libraryWatchPaths, storageLocations } from './storage-paths.js';

describe('recordingsDirFor', () => {
  it('joins recordings under the library root', () => {
    expect(recordingsDirFor('/Users/x/Documents/MeetingNotes')).toBe(
      path.join('/Users/x/Documents/MeetingNotes', 'recordings'),
    );
  });
});

describe('libraryWatchPaths', () => {
  const home = '/Users/x';
  const libraryRoot = '/Users/x/Documents/MeetingNotes';

  it('puts the library recordings dir first, then the legacy folders', () => {
    const paths = libraryWatchPaths({ libraryRoot, audioWatchPath: '', home });
    expect(paths).toEqual([
      path.join(libraryRoot, 'recordings'),
      path.join(home, 'Music', 'MeetingNotes'),
      path.join(home, 'Music', 'Audio Hijack'),
    ]);
  });

  it('omits an empty audioWatchPath', () => {
    const paths = libraryWatchPaths({ libraryRoot, audioWatchPath: '   ', home });
    expect(paths).not.toContain('   ');
    expect(paths).toHaveLength(3);
  });

  it('appends a non-empty audioWatchPath last', () => {
    const extra = '/Users/x/Drops';
    const paths = libraryWatchPaths({ libraryRoot, audioWatchPath: extra, home });
    expect(paths[paths.length - 1]).toBe(extra);
    expect(paths).toHaveLength(4);
  });

  it('dedupes when audioWatchPath equals a legacy path', () => {
    const legacy = path.join(home, 'Music', 'MeetingNotes');
    const paths = libraryWatchPaths({ libraryRoot, audioWatchPath: legacy, home });
    // legacy already present — the duplicate audioWatchPath collapses.
    expect(paths).toEqual([
      path.join(libraryRoot, 'recordings'),
      path.join(home, 'Music', 'MeetingNotes'),
      path.join(home, 'Music', 'Audio Hijack'),
    ]);
    expect(paths.filter((p) => p === legacy)).toHaveLength(1);
  });

  it('dedupes when audioWatchPath equals the recordings dir', () => {
    const rec = path.join(libraryRoot, 'recordings');
    const paths = libraryWatchPaths({ libraryRoot, audioWatchPath: rec, home });
    expect(paths.filter((p) => p === rec)).toHaveLength(1);
    expect(paths).toHaveLength(3);
  });
});

describe('storageLocations', () => {
  const home = '/Users/x';
  const libraryRoot = '/Users/x/Documents/MeetingNotes';

  it('returns the four keyed rows in order', () => {
    const rows = storageLocations({ libraryRoot, home });
    expect(rows.map((r) => r.key)).toEqual(['library', 'models', 'logs', 'hfCache']);
  });

  it('points each row at the expected path', () => {
    const byKey = Object.fromEntries(
      storageLocations({ libraryRoot, home }).map((r) => [r.key, r.path]),
    );
    expect(byKey.library).toBe(libraryRoot);
    expect(byKey.models).toBe(
      path.join(home, 'Library', 'Application Support', 'MeetingNotes', 'whisper-models'),
    );
    expect(byKey.logs).toBe(path.join(home, 'Library', 'Logs', 'MeetingNotes'));
    expect(byKey.hfCache).toBe(path.join(home, '.cache', 'huggingface'));
  });

  it('gives every row a non-empty label and note', () => {
    for (const row of storageLocations({ libraryRoot, home })) {
      expect(row.label.length).toBeGreaterThan(0);
      expect(row.note.length).toBeGreaterThan(0);
    }
  });
});
