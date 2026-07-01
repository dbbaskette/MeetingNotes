import { describe, it, expect } from 'vitest';
import { isKnownReasoningModel } from './reasoning-models';

describe('isKnownReasoningModel', () => {
  it('flags Gemma-family models', () => {
    expect(isKnownReasoningModel('google/gemma-4-12b')).toBe(true);
  });

  it('flags Qwen3-family models, including point releases', () => {
    expect(isKnownReasoningModel('qwen/qwen3.5-9b')).toBe(true);
    expect(isKnownReasoningModel('qwen3-8b-instruct')).toBe(true);
  });

  it('flags DeepSeek-R1', () => {
    expect(isKnownReasoningModel('deepseek-r1-distill-llama-8b')).toBe(true);
  });

  it('flags gpt-oss', () => {
    expect(isKnownReasoningModel('gpt-oss-20b')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isKnownReasoningModel('GEMMA-4-12B')).toBe(true);
  });

  it('does not flag an unrelated model', () => {
    expect(isKnownReasoningModel('llama-3.1-8b')).toBe(false);
  });
});
