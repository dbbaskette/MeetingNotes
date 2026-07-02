import { describe, it, expect } from 'vitest';
import { awaitingGateMeetings } from './awaiting-gate.js';

describe('awaitingGateMeetings', () => {
  it('returns only meetings blocked at the speaker-ID gate (awaiting_user)', () => {
    const out = awaitingGateMeetings([
      { id: 'm1', status: 'awaiting_user', pipelineStage: 'awaiting_speaker_id', title: 'Standup' },
      { id: 'm2', status: 'done', pipelineStage: 'done', title: 'Retro' },
    ]);
    expect(out.map((m) => m.id)).toEqual(['m1']);
  });

  it('is empty when no meeting is awaiting_user', () => {
    const out = awaitingGateMeetings([
      { id: 'm2', status: 'done', pipelineStage: 'done', title: 'Retro' },
      { id: 'm3', status: 'processing', pipelineStage: 'summarizing', title: 'Sync' },
    ]);
    expect(out).toEqual([]);
  });

  it('preserves input order and returns every awaiting meeting for the count', () => {
    const out = awaitingGateMeetings([
      { id: 'a', status: 'awaiting_user' },
      { id: 'b', status: 'done' },
      { id: 'c', status: 'awaiting_user' },
    ]);
    expect(out.map((m) => m.id)).toEqual(['a', 'c']);
    expect(out.length).toBe(2);
  });
});
