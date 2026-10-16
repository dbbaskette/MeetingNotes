import { describe, it, expect } from 'vitest';
import { pickSampleWindow, embeddingForLabel, type DiarizationSegment } from './sample-extractor.js';

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

describe('embeddingForLabel', () => {
  it('never trains native profiles from untagged legacy embeddings', () => {
    expect(embeddingForLabel({ segments: [{ start: 0, end: 1, speaker: 'A', embedding: [3, 4] }] }, 'A')).toBeNull();
  });
  it('normalizes tagged native centroids and rejects absent/zero vectors', () => {
    const artifact = { segments: [], embeddingSpace: 'native:1', centroids: { A: [3, 4], B: [0, 0] } };
    expect(embeddingForLabel(artifact, 'A')).toEqual([0.6, 0.8]);
    expect(embeddingForLabel(artifact, 'B')).toBeNull();
    expect(embeddingForLabel(artifact, 'C')).toBeNull();
  });
});
