import { describe, it, expect } from 'vitest';
import { pickSampleWindow, averageEmbeddingForLabel, type DiarizationSegment } from './sample-extractor.js';

describe('pickSampleWindow', () => {
  it('returns null when speaker has no segments longer than the floor', () => {
    const segs: DiarizationSegment[] = [
      { start: 0, end: 0.3, speaker: 'A' },
      { start: 1, end: 1.2, speaker: 'A' },
    ];
    expect(pickSampleWindow(segs, 'A')).toBeNull();
  });

  it('picks the longest qualifying segment untrimmed when under cap', () => {
    const segs: DiarizationSegment[] = [
      { start: 0, end: 2, speaker: 'A' },
      { start: 5, end: 11, speaker: 'A' }, // 6s long, under 8s cap
      { start: 20, end: 22, speaker: 'A' },
    ];
    expect(pickSampleWindow(segs, 'A')).toEqual({ start: 5, end: 11 });
  });

  it('centers an 8s window inside a long monologue', () => {
    const segs: DiarizationSegment[] = [
      { start: 100, end: 200, speaker: 'B' }, // 100s long
    ];
    const w = pickSampleWindow(segs, 'B');
    expect(w).not.toBeNull();
    expect(w!.end - w!.start).toBeCloseTo(8, 5);
    expect((w!.start + w!.end) / 2).toBeCloseTo(150, 5); // centered
  });

  it('ignores other speakers', () => {
    const segs: DiarizationSegment[] = [
      { start: 0, end: 100, speaker: 'X' },
      { start: 200, end: 204, speaker: 'Y' },
    ];
    expect(pickSampleWindow(segs, 'Y')).toEqual({ start: 200, end: 204 });
  });
});

describe('averageEmbeddingForLabel', () => {
  it('averages only that speakers vectors', () => {
    const segs: DiarizationSegment[] = [
      { start: 0, end: 1, speaker: 'A', embedding: [1, 2, 3] },
      { start: 1, end: 2, speaker: 'B', embedding: [10, 10, 10] },
      { start: 2, end: 3, speaker: 'A', embedding: [3, 4, 5] },
    ];
    expect(averageEmbeddingForLabel(segs, 'A')).toEqual([2, 3, 4]);
  });

  it('returns null when the speaker has no embeddings', () => {
    expect(averageEmbeddingForLabel([], 'A')).toBeNull();
  });
});
