import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { importAudioFiles } from './import-dropped.js';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-import-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
const file = (name: string, body = 'audio'): string => { const p = path.join(tmp, name); fs.writeFileSync(p, body); return p; };

describe('importAudioFiles', () => {
  it('copies supported audio into a destination it creates', async () => {
    const dest = path.join(tmp, 'library', 'recordings');
    const result = await importAudioFiles([file('a.m4a'), file('B.MP3')], dest);
    expect(result).toEqual({ imported: 2, skipped: [] });
    expect(fs.readdirSync(dest).sort()).toEqual(['B.MP3', 'a.m4a']);
  });
  it('skips formats the library cannot catalog, folders and missing files', async () => {
    const dest = path.join(tmp, 'dest');
    fs.mkdirSync(path.join(tmp, 'folder.m4a'));
    const result = await importAudioFiles([file('a.wav'), path.join(tmp, 'folder.m4a'), path.join(tmp, 'gone.mp3'), file('noext')], dest);
    expect(result.imported).toBe(0);
    expect(result.skipped.map((s) => s.reason)).toEqual(['unsupported format .wav', 'not a file', 'not a file', 'unsupported format (none)']);
    expect(fs.readdirSync(dest)).toEqual([]);
  });
  it('never overwrites an existing recording with the same name', async () => {
    const dest = path.join(tmp, 'dest');
    fs.mkdirSync(dest); fs.writeFileSync(path.join(dest, 'a.m4a'), 'original');
    const result = await importAudioFiles([file('a.m4a', 'new')], dest, () => new Date('2026-11-11T10:20:30.000Z'));
    expect(result.imported).toBe(1);
    expect(fs.readFileSync(path.join(dest, 'a.m4a'), 'utf8')).toBe('original');
    expect(fs.readFileSync(path.join(dest, 'a-2026-11-11T10-20-30.m4a'), 'utf8')).toBe('new');
  });
});
