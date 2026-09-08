import { describe, expect, it } from 'vitest';
import { createDetailArtifacts, mergeSpeakerReview, type DetailSpeaker } from './detail-artifacts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('detail artifact generations', () => {
  it('does not publish meeting A after switching to B, even when returning to A', async () => {
    const old = deferred<string>();
    const published: string[] = [];
    const artifacts = createDetailArtifacts({ transcript: () => old.promise }, () => {
      const value = artifacts.get('transcript').data;
      if (value) published.push(value);
    });
    artifacts.selectMeeting('A');
    const pending = artifacts.request('A', 'transcript');
    artifacts.selectMeeting('B');
    artifacts.selectMeeting('A');
    old.resolve('obsolete A');
    await pending;
    expect(published).toEqual([]);
    expect(artifacts.get('transcript').data).toBeUndefined();
  });

  it('shares one promise for duplicate current requests and caches successful content', async () => {
    const result = deferred<string>();
    const requests: string[] = [];
    const artifacts = createDetailArtifacts({ transcript: (id: string) => {
      requests.push(id);
      return result.promise;
    } });
    artifacts.selectMeeting('A');
    const first = artifacts.request('A', 'transcript');
    expect(artifacts.request('A', 'transcript')).toBe(first);
    result.resolve('transcript');
    await first;
    await artifacts.request('A', 'transcript');
    expect(requests).toEqual(['A']);
    expect(artifacts.get('transcript')).toMatchObject({ data: 'transcript', loading: false, error: null });
  });

  it('allows retry after failure and retains loaded content during failed refreshes', async () => {
    const refresh = deferred<string>();
    const responses = [Promise.resolve('original'), refresh.promise, Promise.resolve('updated')];
    const artifacts = createDetailArtifacts({ transcript: () => responses.shift()! });
    artifacts.selectMeeting('A');
    await artifacts.request('A', 'transcript');
    const pending = artifacts.refresh('A');
    expect(artifacts.get('transcript')).toMatchObject({ data: 'original', loading: true });
    refresh.reject(new Error('Read failed'));
    await pending;
    expect(artifacts.get('transcript')).toMatchObject({ data: 'original', loading: false, error: 'Read failed' });
    await artifacts.request('A', 'transcript');
    expect(artifacts.get('transcript')).toMatchObject({ data: 'updated', error: null });
  });

  it('refreshes only previously requested artifact kinds for the active meeting', async () => {
    const requests: string[] = [];
    const artifacts = createDetailArtifacts({
      transcript: async (id: string) => { requests.push(`${id}:transcript`); return 'text'; },
      speakerReview: async (id: string) => { requests.push(`${id}:speakerReview`); return ['speaker']; },
    });
    artifacts.selectMeeting('A');
    await artifacts.refresh('A');
    await artifacts.request('A', 'speakerReview');
    await artifacts.refresh('A');
    artifacts.selectMeeting('B');
    await artifacts.refresh('B');
    await artifacts.request('A', 'transcript');
    expect(requests).toEqual(['A:speakerReview', 'A:speakerReview']);
  });

  it('ignores an older success or failure after stage refresh starts a newer request', async () => {
    for (const outcome of ['success', 'failure']) {
      const old = deferred<string>();
      const fresh = deferred<string>();
      const responses = [old.promise, fresh.promise];
      const artifacts = createDetailArtifacts({ transcript: () => responses.shift()! });
      artifacts.selectMeeting('A');
      const pending = artifacts.request('A', 'transcript');
      const refreshed = artifacts.refresh('A');
      fresh.resolve('new stage');
      await refreshed;
      if (outcome === 'success') old.resolve('old stage');
      else old.reject(new Error('old error'));
      await pending;
      expect(artifacts.get('transcript')).toMatchObject({ data: 'new stage', loading: false, error: null });
    }
  });
});

describe('shell-authoritative speaker review', () => {
  it('keeps updated shell identities and membership after a rejected review refresh', async () => {
    const oldSpeakers: DetailSpeaker[] = [
      { localLabel: 'A', rosterId: 'old', displayName: 'Old name', confidence: 1,
        state: 'confirmed', needsReview: false, segmentCount: 4, durationS: 12, lineCount: 3 },
      { localLabel: 'removed', rosterId: null, displayName: null, confidence: null,
        state: 'unknown', needsReview: true, segmentCount: 1, durationS: 2, lineCount: 1 },
      { localLabel: 'C', rosterId: 'stable', displayName: 'Stable name', confidence: 1,
        state: 'confirmed', needsReview: false, segmentCount: 2, durationS: 8, lineCount: 2 },
    ];
    const refresh = deferred<{ speakers: DetailSpeaker[] }>();
    const responses = [Promise.resolve({ speakers: oldSpeakers }), refresh.promise];
    const artifacts = createDetailArtifacts({ speakerReview: () => responses.shift()! });
    artifacts.selectMeeting('meeting');
    await artifacts.request('meeting', 'speakerReview');
    const updatedShell: DetailSpeaker[] = [
      { localLabel: 'A', rosterId: 'new', displayName: 'New name', confidence: 0.9 },
      { localLabel: 'newly-detected', rosterId: null, displayName: null, confidence: null },
      { localLabel: 'C', rosterId: 'stable', displayName: 'Renamed stable speaker', confidence: 1 },
    ];
    const pending = artifacts.refresh('meeting');
    refresh.reject(new Error('Review unavailable'));
    await pending;

    expect(artifacts.get('speakerReview').error).toBe('Review unavailable');
    expect(mergeSpeakerReview(updatedShell, artifacts.get('speakerReview').data?.speakers)).toEqual([
      { localLabel: 'A', rosterId: 'new', displayName: 'New name', confidence: 0.9,
        segmentCount: 4, durationS: 12, lineCount: 3 },
      { localLabel: 'newly-detected', rosterId: null, displayName: null, confidence: null },
      { localLabel: 'C', rosterId: 'stable', displayName: 'Renamed stable speaker', confidence: 1,
        state: 'confirmed', needsReview: false, segmentCount: 2, durationS: 8, lineCount: 2 },
    ]);
  });

  it('does not hide newly detected shell speakers behind a cached empty review', async () => {
    const refresh = deferred<{ speakers: DetailSpeaker[] }>();
    const responses = [Promise.resolve({ speakers: [] as DetailSpeaker[] }), refresh.promise];
    const artifacts = createDetailArtifacts({ speakerReview: () => responses.shift()! });
    artifacts.selectMeeting('meeting');
    await artifacts.request('meeting', 'speakerReview');
    const pending = artifacts.refresh('meeting');
    refresh.reject(new Error('Review unavailable'));
    await pending;
    expect(mergeSpeakerReview([
      { localLabel: 'new', rosterId: null, displayName: null, confidence: null },
    ], artifacts.get('speakerReview').data?.speakers)).toEqual([
      { localLabel: 'new', rosterId: null, displayName: null, confidence: null },
    ]);
  });

  it('does not retain identity-dependent review badges after unlink or confidence changes', () => {
    const reviewed: DetailSpeaker = {
      localLabel: 'A', rosterId: 'person', displayName: 'Person', confidence: 1,
      state: 'confirmed', needsReview: false, segmentCount: 4, durationS: 12, lineCount: 3,
    };
    expect(mergeSpeakerReview([
      { localLabel: 'A', rosterId: null, displayName: null, confidence: null },
    ], [reviewed])).toEqual([
      { localLabel: 'A', rosterId: null, displayName: null, confidence: null,
        segmentCount: 4, durationS: 12, lineCount: 3 },
    ]);
    expect(mergeSpeakerReview([
      { localLabel: 'A', rosterId: 'person', displayName: 'Person', confidence: 0.7 },
    ], [reviewed])).toEqual([
      { localLabel: 'A', rosterId: 'person', displayName: 'Person', confidence: 0.7,
        segmentCount: 4, durationS: 12, lineCount: 3 },
    ]);
  });
});
