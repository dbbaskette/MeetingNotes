import { describe, it, expect } from 'vitest';
import {
  STAGES, previousCompletedOnCrash,
} from './stage-machine.js';

describe('stage-machine', () => {
  it('lists stages in canonical order', () => {
    expect(STAGES).toEqual([
      'discovered', 'transcribing', 'diarizing', 'merging',
      'identifying', 'awaiting_speaker_id',
      'summarizing', 'extracting', 'done',
    ]);
  });

  it('previousCompletedOnCrash returns the stage to restart at after an interrupted run', () => {
    expect(previousCompletedOnCrash('transcribing')).toBe('discovered');
    expect(previousCompletedOnCrash('diarizing')).toBe('discovered');
    expect(previousCompletedOnCrash('merging')).toBe('merging');
    expect(previousCompletedOnCrash('summarizing')).toBe('summarizing');
    expect(previousCompletedOnCrash('done')).toBe('done');
    expect(previousCompletedOnCrash('discovered')).toBe('discovered');
  });
});
