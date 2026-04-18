import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../storage/db.js';
import { SpeakersRepo } from '../storage/speakers-repo.js';
import { RosterService } from './roster-service.js';

let svc: RosterService;
let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-roster-'));
  const db = openDb(path.join(tmp, 'db.sqlite'));
  svc = new RosterService(new SpeakersRepo(db), tmp);
});

describe('RosterService', () => {
  it('confirmSpeaker creates a new speaker and persists embedding', () => {
    const id = svc.confirmSpeaker({ displayName: 'Dan', embedding: new Array(512).fill(0.1) });
    expect(svc.loadEmbedding(id)).toHaveLength(512);
  });

  it('identifyUnknowns auto-links when above threshold', () => {
    const id = svc.confirmSpeaker({ displayName: 'Dan', embedding: [1, 0, 0] });
    const m = svc.identifyUnknowns([{ label: 'Speaker 1', embedding: [0.99, 0.01, 0] }]);
    expect(m[0]!.rosterId).toBe(id);
  });

  it('confirm on existing speaker updates running average embedding', () => {
    const id = svc.confirmSpeaker({ displayName: 'Dan', embedding: [1, 0, 0] });
    svc.confirmSpeakerFor(id, [0, 1, 0]);
    const e = svc.loadEmbedding(id);
    expect(e[0]).toBeCloseTo(0.7, 6);
    expect(e[1]).toBeCloseTo(0.3, 6);
  });
});
