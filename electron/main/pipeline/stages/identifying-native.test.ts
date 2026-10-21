import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { openDb } from '../../storage/db.js';
import { MeetingsRepo } from '../../storage/meetings-repo.js';
import { SpeakersRepo } from '../../storage/speakers-repo.js';
import { SettingsRepo } from '../../storage/settings-repo.js';
import { RosterService } from '../../speakers/roster-service.js';
import { VoiceProfiles } from '../../speakers/voice-profiles.js';
import { buildSpeakerReviewMetadata } from '../../speakers/review-metadata.js';
import { runIdentifying } from './identifying.js';
import type { PipelineContext } from '../context.js';

it('identifies from native profiles when enabled, preserves manual links, gates unknowns and never self-trains', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-identify-native-'));
  const db = openDb(path.join(root, 'db.sqlite'));
  try {
    const meetings = new MeetingsRepo(db), speakers = new SpeakersRepo(db), settings = new SettingsRepo(db);
    meetings.insert({ id: 'm', slug: 'm', title: 'Meeting', startedAt: null, durationS: 50, audioPath: '/fixture', status: 'processing', pipelineStage: 'identifying' });
    const roster = new RosterService(speakers, root), space = 'speakerkit:test:raw';
    const alice = roster.confirmSpeaker({ displayName: 'Alice', embedding: [1, 0, 0] }, space);
    const bob = roster.confirmSpeaker({ displayName: 'Bob', embedding: [0, 1, 0] }, space);
    const profiles = new VoiceProfiles(root), before = profiles.load(space, alice);
    const segments = [{ speaker: 'A', start: 0, end: 6 }, { speaker: 'A', start: 10, end: 16 },
      { speaker: 'B', start: 20, end: 26 }, { speaker: 'B', start: 30, end: 36 }, { speaker: 'unknown', start: 40, end: 41 }];
    const folder = path.join(root, 'meetings', 'm'); fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'diarization.json'), JSON.stringify({ embeddingSpace: space,
      centroids: { A: [1, 0, 0], B: [0, 1, 0], unknown: [0, 0, 1] }, segments }));
    const ctx = { libraryRoot: root, meetings, speakers, settings, roster, logger: { info() {} } } as unknown as PipelineContext;
    await runIdentifying({ meetingId: 'm' }, ctx);
    expect(speakers.listForMeeting('m').every(s => !s.rosterSpeakerId)).toBe(true);
    settings.set('autoMatchSpeakers', true);
    await runIdentifying({ meetingId: 'm' }, ctx);
    const links = speakers.listForMeeting('m');
    expect(links.find(s => s.localLabel === 'A')).toMatchObject({ rosterSpeakerId: alice, assignmentSource: 'automatic', confidence: 1 });
    expect(links.find(s => s.localLabel === 'B')).toMatchObject({ rosterSpeakerId: bob, assignmentSource: 'automatic' });
    const review = buildSpeakerReviewMetadata({ links: links.map(s => ({ ...s, rosterId: s.rosterSpeakerId })), diarization: segments, transcript: [] });
    expect(review.get('A')).toMatchObject({ state: 'automatic', needsReview: false });
    expect(review.get('unknown')?.needsReview).toBe(true);
    expect(profiles.load(space, alice)).toEqual(before);
    speakers.linkToMeeting('m', 'A', bob, 1);
    await runIdentifying({ meetingId: 'm' }, ctx);
    expect(speakers.listForMeeting('m').find(s => s.localLabel === 'A')).toMatchObject({ rosterSpeakerId: bob, assignmentSource: 'manual' });
  } finally { db.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
