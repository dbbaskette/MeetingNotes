import { describe, it, expect } from 'vitest';
import { CONTEXT_OVERFLOW_MARKER, isContextOverflowError } from './context-overflow.js';
import { CONTEXT_OVERFLOW_MARKER as MAIN_MARKER } from '../../../main/lm-studio/client.js';

describe('CONTEXT_OVERFLOW_MARKER parity', () => {
  it('matches the main-process constant the LM Studio client throws with', () => {
    expect(CONTEXT_OVERFLOW_MARKER).toBe(MAIN_MARKER);
  });

  it('recognises the overflow message and nothing else', () => {
    expect(isContextOverflowError('The prompt is 17,447 tokens but the model is loaded with 16,384 tokens of context.')).toBe(true);
    expect(isContextOverflowError('LM Studio 500 on /v1/chat/completions')).toBe(false);
    expect(isContextOverflowError(null)).toBe(false);
  });
});
