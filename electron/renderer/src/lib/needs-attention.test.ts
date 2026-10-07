import { describe, expect, it } from 'vitest';
import { buildNeedsAttention, capAttentionGroups, retainInboxOnFailure } from './needs-attention.js';

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

  it('caps each group and reports how many items were hidden', () => {
    const meetings = Array.from({ length: 5 }, (_, i) => ({
      id: `p${i}`, title: `Pending ${i}`, status: 'pending' as const,
      pipelineStage: 'discovered', startedAt: `2026-08-12T0${i}:00:00Z`,
    }));
    const groups = capAttentionGroups(buildNeedsAttention({
      nowMs: Date.parse('2026-08-12T16:00:00Z'), recovery: [], meetings,
    }), 2);
    expect(groups[0]?.items).toHaveLength(2);
    expect(groups[0]?.hiddenCount).toBe(3);
    expect(groups[0]?.totalCount).toBe(5);
  });

  it('keeps the previous recovery inbox when a refresh fails', () => {
    const previous = [{ id: 'r1' }];
    expect(retainInboxOnFailure(previous, new Error('recovery unavailable'))).toEqual({
      items: previous, error: 'recovery unavailable',
    });
    expect(retainInboxOnFailure([], 'busy')).toEqual({
      items: [], error: 'busy',
    });
  });
});
