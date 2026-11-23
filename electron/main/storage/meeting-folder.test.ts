import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMeetingFolder } from './meeting-folder.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mn-folder-'));
const dirs: string[] = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

describe('createMeetingFolder', () => {
  it('creates folder and symlinks audio', () => {
    const root = tmp(); dirs.push(root);
    const audio = path.join(root, 'source.mp3');
    fs.writeFileSync(audio, Buffer.from('x'));
    const folder = createMeetingFolder(root, '2026-04-17-test-abc1', audio);
    expect(fs.existsSync(folder)).toBe(true);
    const stat = fs.lstatSync(path.join(folder, 'audio.mp3'));
    expect(stat.isSymbolicLink()).toBe(true);
  });
});
