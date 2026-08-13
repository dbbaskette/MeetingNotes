import { describe, expect, it } from 'vitest';
import { buildNeedsAttention } from './needs-attention.js';

describe('buildNeedsAttention', () => {
  it('groups actionable work by urgency and oldest first within a group', () => {
    const result = buildNeedsAttention({
      nowMs: Date.parse('2026-08-12T16:00:00Z'),
      recovery: [{ id: 'r1', startedAt: '2026-08-10T10:00:00Z', targetLabel: 'Zoom' }],
      meetings: [
        { id: 'p1', title: 'Newest pending', status: 'pending', pipelineStage: 'discovered', startedAt: '2026-08-12T15:00:00Z' },
        { id: 's1', title: 'Speaker review', status: 'awaiting_user', pipelineStage: 'awaiting_speaker_id', startedAt: '2026-08-11T15:00:00Z' },
        { id: 'f1', title: 'Failed', status: 'failed', pipelineStage: 'summarizing', startedAt: '2026-08-09T15:00:00Z' },
      ],
    });

    expect(result.map((group) => group.kind)).toEqual(['recovery', 'failed', 'speaker', 'pending']);
    expect(result.flatMap((group) => group.items).every((item) => item.ageLabel.length > 0)).toBe(true);
    expect(result.find((group) => group.kind === 'failed')?.items[0]?.actionLabel).toBe('Review failure');
  });

  it('returns no groups when nothing needs intervention', () => {
    expect(buildNeedsAttention({
      nowMs: Date.now(), recovery: [],
      meetings: [{ id: 'done', title: 'Done', status: 'done', pipelineStage: 'done', startedAt: null }],
    })).toEqual([]);
  });
});
