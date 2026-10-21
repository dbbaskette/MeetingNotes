import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../storage/db.js';
import { SpeakersRepo } from '../storage/speakers-repo.js';
import { RosterService } from './roster-service.js';
import { VoiceProfiles, normalized } from './voice-profiles.js';
let svc: RosterService, tmp: string, db: ReturnType<typeof openDb>, profiles: VoiceProfiles;
const space = 'speakerkit:model-a:raw';
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-roster-'));
  db = openDb(path.join(tmp, 'db.sqlite')); svc = new RosterService(new SpeakersRepo(db), tmp); profiles = new VoiceProfiles(tmp);
});
afterEach(() => { db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
describe('RosterService', () => {
  const segments = [{ start: 0, end: 6, speaker: 'A' }, { start: 10, end: 16, speaker: 'A' }];
  const options = { enabled: true, space, segments };
  it('auto-assigns a strong native match only when explicitly enabled, without training', () => {
    const id = svc.confirmSpeaker({ displayName: 'Dan', embedding: [1, 0] }, space);
    const before = profiles.load(space, id);
    expect(svc.identifyUnknowns([{ label: 'A', embedding: [0.99, 0.1] }], options)[0])
      .toMatchObject({ rosterId: id, confidence: expect.any(Number) });
    expect(profiles.load(space, id)).toEqual(before);
    expect(svc.identifyUnknowns([{ label: 'A', embedding: [1, 0] }], { ...options, enabled: false })[0]?.rosterId).toBeNull();
  });
  it('compares unrounded scores and refuses insufficient score or runner-up separation', () => {
    svc.confirmSpeaker({ displayName: 'Dan', embedding: [1, 0] }, space);
    const score = 0.9799;
    expect(svc.identifyUnknowns([{ label: 'A', embedding: [score, Math.sqrt(1 - score * score)] }], options)[0]?.rosterId).toBeNull();
    svc.confirmSpeaker({ displayName: 'Similar voice', embedding: [0.97, Math.sqrt(1 - 0.97 ** 2)] }, space);
    expect(svc.identifyUnknowns([{ label: 'A', embedding: [1, 0] }], options)[0]?.rosterId).toBeNull();
  });
  it('leaves short, one-turn and overlapped voices in review', () => {
    svc.confirmSpeaker({ displayName: 'Dan', embedding: [1, 0] }, space);
    for (const evidence of [[], [{ start: 0, end: 20, speaker: 'A' }],
      [{ start: 0, end: 3, speaker: 'A' }, { start: 5, end: 8, speaker: 'A' }],
      [...segments, { start: 0, end: 20, speaker: 'B' }]]) {
      expect(svc.identifyUnknowns([{ label: 'A', embedding: [1, 0] }], { ...options, segments: evidence })[0]?.rosterId).toBeNull();
    }
  });
  it('refuses duplicate identity claims and already named identities', () => {
    const id = svc.confirmSpeaker({ displayName: 'Dan', embedding: [1, 0] }, space);
    expect(svc.identifyUnknowns([{ label: 'A', embedding: [1, 0] }], { ...options, reservedRosterIds: [id] })[0]?.rosterId).toBeNull();
    const detected = [{ label: 'A', embedding: [1, 0] }, { label: 'B', embedding: [1, 0] }];
    const both = { ...options, segments: [...segments, { start: 20, end: 26, speaker: 'B' }, { start: 30, end: 36, speaker: 'B' }] };
    expect(svc.identifyUnknowns(detected, both).every(s => s.rosterId === null)).toBe(true);
    expect(svc.identifyUnknowns([...detected].reverse(), both).every(s => s.rosterId === null)).toBe(true);
  });
  it('never crosses model spaces/dimensions or uses invalid vectors', () => {
    svc.confirmSpeaker({ displayName: 'Dan', embedding: [1, 0] }, space);
    for (const overrides of [{ space: undefined }, { space: 'different-model' }]) {
      expect(svc.identifyUnknowns([{ label: 'A', embedding: [1, 0] }], { ...options, ...overrides })[0]?.rosterId).toBeNull();
    }
    for (const embedding of [[1, 0, 0], [], [0, 0], [NaN, 0]]) {
      expect(svc.identifyUnknowns([{ label: 'A', embedding }], options)[0]?.rosterId).toBeNull();
    }
  });
  it('persists only confirmed model-tagged native embeddings', () => {
    const id = svc.confirmSpeaker({ displayName: 'Dan', embedding: [3, 4] }, space);
    expect(profiles.load(space, id)).toEqual([0.6, 0.8]);
    expect(profiles.load('another-model', id)).toBeNull();
  });
  it('requires confirmation even for a strong voice match', () => {
    svc.confirmSpeaker({ displayName: 'Dan', embedding: [1, 0, 0] }, space);
    expect(svc.identifyUnknowns([{ label: 'A', embedding: [1, 0, 0] }])[0]?.rosterId).toBeNull();
  });
  it('updates the normalized running average after confirmation', () => {
    const id = svc.confirmSpeaker({ displayName: 'Dan', embedding: [1, 0, 0] }, space);
    svc.confirmSpeakerFor(id, [0, 1, 0], space);
    expect(profiles.load(space, id)).toEqual(normalized([0.7, 0.3, 0]));
  });
  it('reuses names case/whitespace-insensitively', () => {
    const id = svc.confirmSpeaker({ displayName: 'Dan', embedding: [1, 0] }, space);
    expect(svc.confirmSpeaker({ displayName: '  dan  ', embedding: [0, 1] }, space)).toBe(id);
  });
  it('ranks native suggestions as similarity, not probability', () => {
    const aliceId = svc.confirmSpeaker({ displayName: 'Alice', embedding: [1, 0] }, space);
    const bobId = svc.confirmSpeaker({ displayName: 'Bob', embedding: [0, 1] }, space);
    const out = svc.suggestionsFor({ label: 'A', embedding: [0.9, 0.1] }, 3, space);
    expect(out[0]).toMatchObject({ id: aliceId, displayName: 'Alice', scoreKind: 'similarity' });
    expect(out[0]!.confidence).toBeGreaterThan(out[1]!.confidence);
    expect(out[1]!.id).toBe(bobId);
    expect(svc.suggestionsFor({ label: 'A', embedding: [1, 0] })).toEqual([]);
  });
  it('returns no suggestions for an empty roster', () => {
    expect(svc.suggestionsFor({ label: 'A', embedding: [1, 0] }, 3, space)).toEqual([]);
  });
});
