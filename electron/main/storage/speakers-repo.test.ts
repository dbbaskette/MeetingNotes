import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from './db.js';
import { SpeakersRepo } from './speakers-repo.js';

let repo: SpeakersRepo;
beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-sp-'));
  repo = new SpeakersRepo(openDb(path.join(dir, 'db.sqlite')));
});

describe('SpeakersRepo', () => {
  it('create + list', () => {
    const id = repo.create({ displayName: 'Dan B.' });
    expect(repo.list()).toEqual([expect.objectContaining({ id, displayName: 'Dan B.' })]);
  });

  it('rename', () => {
    const id = repo.create({ displayName: 'Temp' });
    repo.rename(id, 'Dan Baskette');
    expect(repo.findById(id)?.displayName).toBe('Dan Baskette');
  });

  it('delete', () => {
    const id = repo.create({ displayName: 'Gone' });
    repo.delete(id);
    expect(repo.findById(id)).toBeNull();
  });
});
