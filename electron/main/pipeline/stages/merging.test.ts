import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runMerging } from './merging.js';
import { ArtifactCache } from '../../library/artifact-cache.js';

describe('runMerging', () => {
  it('invalidates transcript and review sources before writing despite unchanged fingerprints', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-merge-cache-'));
    try {
      const folder = path.join(dir, 'meetings', 'slug');
      fs.mkdirSync(folder, { recursive: true });
      const transcriptPath = path.join(folder, 'transcript.md');
      const rawPath = path.join(folder, 'transcript.raw.json');
      const diarPath = path.join(folder, 'diarization.json');
      const oldRaw = JSON.stringify({ segments: [{ start: 0, end: 1, text: 'Hi.' }] });
      const newRaw = JSON.stringify({ segments: [{ start: 0, end: 1, text: 'Yo.' }] });
      const oldDiar = JSON.stringify({ segments: [{ start: 0, end: 1, speaker: 'SPEAKER_00' }] });
      const newDiar = JSON.stringify({ segments: [{ start: 0, end: 1, speaker: 'SPEAKER_01' }] });
      fs.writeFileSync(transcriptPath, '[SPEAKER_00 00:00] Hi.');
      fs.writeFileSync(rawPath, oldRaw);
      fs.writeFileSync(diarPath, oldDiar);
      const artifactCache = new ArtifactCache({
        stat: async (filePath) => ({ size: fs.statSync(filePath).size, mtimeMs: 1, ctimeMs: 1 }),
      });
      await Promise.all([transcriptPath, rawPath, diarPath].map((filePath) => artifactCache.readText(filePath)));
      fs.writeFileSync(rawPath, newRaw);
      fs.writeFileSync(diarPath, newDiar);
      const writeFileSync = fs.writeFileSync.bind(fs);
      let entriesAtWrite = -1;
      const write = vi.spyOn(fs, 'writeFileSync').mockImplementation((...args) => {
        entriesAtWrite = artifactCache.stats().entries;
        return writeFileSync(...args);
      });
      try {
        await runMerging({ meetingId: 'm' }, {
          libraryRoot: dir, artifactCache,
          meetings: { findById: () => ({ slug: 'slug' }) },
          speakers: { listForMeeting: () => [] },
          settings: { get: () => '' }, logger: { info: () => {} },
        } as any);
      } finally {
        write.mockRestore();
      }
      expect(await artifactCache.readText(transcriptPath)).toBe('[SPEAKER_01 00:00] Yo.');
      expect(await artifactCache.readText(rawPath)).toBe(newRaw);
      expect(await artifactCache.readText(diarPath)).toBe(newDiar);
      expect(entriesAtWrite).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads transcript.raw.json + diarization.json, writes transcript.md', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-m-'));
    const f = path.join(dir, 'meetings', 'slug');
    fs.mkdirSync(f, { recursive: true });
    fs.writeFileSync(
      path.join(f, 'transcript.raw.json'),
      JSON.stringify({
        text: 'Hi. There.',
        segments: [
          { start: 0, end: 1, text: 'Hi.' },
          { start: 1, end: 2, text: 'There.' },
        ],
      }),
    );
    fs.writeFileSync(
      path.join(f, 'diarization.json'),
      JSON.stringify({
        segments: [
          { start: 0, end: 1.2, speaker: 'SPEAKER_00', embedding: [] },
          { start: 1.2, end: 3, speaker: 'SPEAKER_01', embedding: [] },
        ],
        num_speakers: 2,
      }),
    );
    const ctx: any = {
      libraryRoot: dir,
      artifactCache: new ArtifactCache(),
      meetings: { findById: () => ({ slug: 'slug' }) },
      speakers: { listForMeeting: () => [] },
      logger: { info: () => {} },
      settings: { get: () => '' },
    };
    await runMerging({ meetingId: 'm' }, ctx);
    const md = fs.readFileSync(path.join(f, 'transcript.md'), 'utf8');
    expect(md).toContain('[SPEAKER_00 00:00] Hi.');
    expect(md).toContain('[SPEAKER_01 00:01] There.');
  });

  it('substitutes roster display names for labels the user identified', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-m-named-'));
    const f = path.join(dir, 'meetings', 'slug');
    fs.mkdirSync(f, { recursive: true });
    fs.writeFileSync(
      path.join(f, 'transcript.raw.json'),
      JSON.stringify({
        segments: [
          { start: 0, end: 1, text: 'Hi.' },
          { start: 1, end: 2, text: 'There.' },
        ],
      }),
    );
    fs.writeFileSync(
      path.join(f, 'diarization.json'),
      JSON.stringify({
        segments: [
          { start: 0, end: 1.2, speaker: 'SPEAKER_00', embedding: [] },
          { start: 1.2, end: 3, speaker: 'SPEAKER_01', embedding: [] },
        ],
      }),
    );
    const ctx: any = {
      libraryRoot: dir,
      artifactCache: new ArtifactCache(),
      meetings: { findById: () => ({ slug: 'slug' }) },
      speakers: {
        // SPEAKER_00 → named, SPEAKER_01 → still anonymous (rosterId but no
        // displayName wouldn't happen in practice; we simulate one-of-each).
        listForMeeting: () => [
          { localLabel: 'SPEAKER_00', rosterSpeakerId: 'r1', displayName: 'Alice', confidence: 1 },
          { localLabel: 'SPEAKER_01', rosterSpeakerId: null, displayName: null, confidence: null },
        ],
      },
      logger: { info: () => {} },
      settings: { get: () => '' },
    };
    await runMerging({ meetingId: 'm' }, ctx);
    const md = fs.readFileSync(path.join(f, 'transcript.md'), 'utf8');
    expect(md).toContain('[Alice 00:00] Hi.');
    expect(md).toContain('[SPEAKER_01 00:01] There.'); // unidentified stays raw
  });

  it('labels voice-stem segments with userName (or "You" when unset) and bypasses diarization', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-m-stem-'));
    const f = path.join(dir, 'meetings', 'slug');
    fs.mkdirSync(f, { recursive: true });
    fs.writeFileSync(
      path.join(f, 'transcript.raw.json'),
      JSON.stringify({
        segments: [
          { start: 0, end: 2, text: 'Hey everyone.', source: 'voice' },      // local user (mic stem)
          { start: 3, end: 5, text: 'Hi Dan.', source: 'system' },           // remote
          { start: 6, end: 8, text: 'Thanks for joining.', source: 'voice' },
        ],
      }),
    );
    // Diarization only covers the system side — voice segments bypass it entirely.
    fs.writeFileSync(
      path.join(f, 'diarization.json'),
      JSON.stringify({
        segments: [{ start: 3, end: 5, speaker: 'SPEAKER_00', embedding: [] }],
      }),
    );
    const ctx: any = {
      libraryRoot: dir,
      artifactCache: new ArtifactCache(),
      meetings: { findById: () => ({ slug: 'slug' }) },
      speakers: { listForMeeting: () => [] },
      logger: { info: () => {} },
      settings: { get: (k: string) => (k === 'userName' ? 'Dan' : '') },
    };
    await runMerging({ meetingId: 'm' }, ctx);
    const md = fs.readFileSync(path.join(f, 'transcript.md'), 'utf8');
    expect(md).toContain('[Dan 00:00] Hey everyone.');
    expect(md).toContain('[SPEAKER_00 00:03] Hi Dan.');
    expect(md).toContain('[Dan 00:06] Thanks for joining.');
  });

  it('survives a missing diarization.json (voice segments still render)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-m-nodiar-'));
    const f = path.join(dir, 'meetings', 'slug');
    fs.mkdirSync(f, { recursive: true });
    fs.writeFileSync(
      path.join(f, 'transcript.raw.json'),
      JSON.stringify({
        segments: [
          { start: 0, end: 2, text: 'Just me here.', source: 'voice' },
        ],
      }),
    );
    // No diarization.json on disk.
    const ctx: any = {
      libraryRoot: dir,
      artifactCache: new ArtifactCache(),
      meetings: { findById: () => ({ slug: 'slug' }) },
      speakers: { listForMeeting: () => [] },
      logger: { info: () => {} },
      settings: { get: () => '' },
    };
    await runMerging({ meetingId: 'm' }, ctx);
    const md = fs.readFileSync(path.join(f, 'transcript.md'), 'utf8');
    expect(md).toContain('[You 00:00] Just me here.');
  });
});
