import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VoiceProfiles } from './voice-profiles.js';
import { openDb } from '../storage/db.js';
import { SpeakersRepo } from '../storage/speakers-repo.js';
import { RosterService } from './roster-service.js';

let root: string, store: VoiceProfiles;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-profiles-')); store = new VoiceProfiles(root); });
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });
it('keeps matching after merge; preserves originals and makes repeat merge idempotent', () => {
  const db = openDb(':memory:');
  try {
    const repo = new SpeakersRepo(db), service = new RosterService(repo, root);
    const source = repo.create({ displayName: 'Daniel' }), target = repo.create({ displayName: 'Dan' });
    store.confirm('native-a', source, [1, 0], 'Planning · SPEAKER_00');
    store.merge(source, target); repo.mergeSpeakers(source, target);
    expect(service.suggestionsFor({ label: 'A', embedding: [1, 0] }, 3, 'native-a')[0]?.id).toBe(target);
    expect(store.load('native-a', source)).toEqual([1, 0]);
    const info = store.info(target); store.merge(source, target);
    expect(store.info(target)).toEqual(info);
    store.undo('native-a', target); expect(store.load('native-a', target)).toBeNull();
    store.merge(source, target); expect(store.load('native-a', target)).toEqual([1, 0]);
  } finally { db.close(); }
});
it('preserves each model space, validates all spaces before writes and rejects symlinks', () => {
  store.confirm('a', 'source', [1, 0]); store.confirm('b', 'source', [1, 0]); store.confirm('b', 'target', [1, 0, 0]);
  expect(() => store.merge('source', 'target')).toThrow(/incompatible/);
  expect(store.load('a', 'target')).toBeNull();
  fs.symlinkSync(root, path.join(root, 'voice-profiles', 'a'.repeat(64)));
  expect(store.info('source')).toHaveLength(2);
});
it('undo restores the previous vector and provenance across new service instances', () => {
  store.confirm('a', 'person', [1, 0], 'First meeting');
  store.confirm('a', 'person', [0, 1], 'Mistaken confirmation');
  expect(store.info('person')[0]?.source).toBe('Mistaken confirmation');
  new VoiceProfiles(root).undo('a', 'person');
  expect(store.load('a', 'person')).toEqual([1, 0]);
  expect(store.info('person')[0]?.source).toBe('First meeting');
  store.undo('a', 'person'); expect(store.load('a', 'person')).toBeNull();
});
it('rolls target profiles back if the database merge fails', () => {
  store.confirm('a', 'source', [1, 0]); store.confirm('a', 'target', [0, 1]);
  const before = store.info('target');
  expect(() => store.merge('source', 'target', () => { throw new Error('DB unavailable'); })).toThrow('DB unavailable');
  expect(store.load('a', 'target')).toEqual([0, 1]); expect(store.info('target')).toEqual(before);
});
it('batch suggestions read 50 profiles once, not once per voice; confirmation invalidates cache', () => {
  const db = openDb(':memory:');
  try {
    const repo = new SpeakersRepo(db), service = new RosterService(repo, root);
    for (let i = 0; i < 50; i++) store.confirm('a', repo.create({ displayName: `Person ${i}` }), [1, i / 50]);
    const spy = vi.spyOn(fs, 'readFileSync');
    const detected = Array.from({ length: 20 }, (_, i) => ({ label: `SPEAKER_${i}`, embedding: [1, 0] }));
    service.suggestionsBatch(detected, 'a'); expect(spy).toHaveBeenCalledTimes(50);
    spy.mockClear(); service.suggestionsBatch(detected, 'a'); expect(spy).not.toHaveBeenCalled();
    const id = repo.list()[0]!.id; store.confirm('a', id, [0, 1], 'New meeting');
    spy.mockClear(); service.suggestionsBatch(detected, 'a'); expect(spy).toHaveBeenCalledTimes(1);
  } finally { db.close(); }
});
