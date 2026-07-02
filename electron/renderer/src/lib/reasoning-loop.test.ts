import { describe, it, expect } from 'vitest';
import { REASONING_LOOP_MARKER } from './reasoning-loop.js';
import { REASONING_LOOP_MARKER as MAIN_MARKER } from '../../../main/lm-studio/client.js';

describe('REASONING_LOOP_MARKER parity', () => {
  it('matches the main-process constant the LM Studio client throws with', () => {
    // The renderer gates the failure banner's recovery controls on this
    // substring appearing in meeting.errorMessage. If the client's error
    // wording changes without this copy, the controls silently stop showing.
    expect(REASONING_LOOP_MARKER).toBe(MAIN_MARKER);
  });
});
