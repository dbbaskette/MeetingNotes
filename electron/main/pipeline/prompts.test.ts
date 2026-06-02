import { describe, it, expect } from 'vitest';
import { buildSummaryPrompt } from './prompts.js';

describe('buildSummaryPrompt', () => {
  it('includes the Off-topic Conversation section and its content rule', () => {
    const p = buildSummaryPrompt('detailed');
    expect(p).toContain('## Off-topic Conversation');
    expect(p).toContain('OPENS or CLOSES');
    expect(p).toContain('Omit this section entirely if there was no such chatter;');
    expect(p).toContain('it MUST be the final section');
  });

  it('anchors on the known topic when one is given', () => {
    const p = buildSummaryPrompt('detailed', 'Q3 roadmap planning');
    expect(p).toContain('This meeting is about: **Q3 roadmap planning**');
    expect(p).not.toContain('Infer the meeting');
  });

  it('falls back to inferring the topic when none is given', () => {
    const p = buildSummaryPrompt('detailed');
    expect(p).toContain("Infer the meeting's main purpose from the transcript itself.");
    expect(p).not.toContain('This meeting is about:');
  });

  it('treats null knownTopic the same as omitted (infer)', () => {
    const p = buildSummaryPrompt('detailed', null);
    expect(p).toContain("Infer the meeting's main purpose from the transcript itself.");
    expect(p).not.toContain('This meeting is about:');
  });
});
