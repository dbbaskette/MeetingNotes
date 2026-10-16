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
