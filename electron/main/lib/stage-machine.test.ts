import { describe, it, expect } from 'vitest';
import {
  STAGES, nextStage, previousCompletedOnCrash, downstreamOf, isValidTransition,
} from './stage-machine.js';

describe('stage-machine', () => {
  it('lists stages in canonical order', () => {
    expect(STAGES).toEqual([
      'discovered', 'transcribing', 'diarizing', 'merging',
      'identifying', 'awaiting_speaker_id',
      'summarizing', 'extracting', 'done',
    ]);
  });

  it('nextStage advances one step; null at done', () => {
    expect(nextStage('discovered')).toBe('transcribing');
    expect(nextStage('identifying')).toBe('awaiting_speaker_id');
    expect(nextStage('awaiting_speaker_id')).toBe('summarizing');
    expect(nextStage('extracting')).toBe('done');
    expect(nextStage('done')).toBeNull();
  });

  it('isValidTransition allows forward single-step only (+ restart from any stage)', () => {
    expect(isValidTransition('discovered', 'transcribing')).toBe(true);
    expect(isValidTransition('discovered', 'merging')).toBe(false);
    expect(isValidTransition('done', 'transcribing')).toBe(true);
  });

  it('previousCompletedOnCrash returns the stage to restart at after an interrupted run', () => {
    expect(previousCompletedOnCrash('transcribing')).toBe('discovered');
    expect(previousCompletedOnCrash('diarizing')).toBe('discovered');
    expect(previousCompletedOnCrash('merging')).toBe('merging');
    expect(previousCompletedOnCrash('summarizing')).toBe('summarizing');
    expect(previousCompletedOnCrash('done')).toBe('done');
    expect(previousCompletedOnCrash('discovered')).toBe('discovered');
  });

  it('downstreamOf returns all stages after a given one', () => {
    expect(downstreamOf('merging')).toEqual([
      'identifying', 'awaiting_speaker_id', 'summarizing', 'extracting', 'done',
    ]);
  });
});
