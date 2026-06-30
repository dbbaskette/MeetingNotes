import { describe, it, expect } from 'vitest';
import { buildSummaryPrompt, ACTION_ITEM_SYSTEM_PROMPT } from './prompts.js';

describe('ACTION_ITEM_SYSTEM_PROMPT', () => {
  it('forbids reasoning preamble so reasoning models emit the JSON directly', () => {
    // Regression guard: Gemma-class models ignore enable_thinking and otherwise
    // burn their whole budget restating the transcript before any JSON. The
    // prompt must hard-mandate an immediate answer (parity with the summary
    // prompt's "No preamble" contract).
    expect(ACTION_ITEM_SYSTEM_PROMPT).toContain('FIRST character you output must be "["');
    expect(ACTION_ITEM_SYSTEM_PROMPT).toContain('Do NOT think out loud');
    expect(ACTION_ITEM_SYSTEM_PROMPT).toContain('skip your chain-of-thought');
  });

  it('still requires a bare JSON array with no fences', () => {
    expect(ACTION_ITEM_SYSTEM_PROMPT).toContain('Return ONLY the JSON array');
    expect(ACTION_ITEM_SYSTEM_PROMPT).toContain('no code fences');
  });
});

describe('buildSummaryPrompt', () => {
  it('includes the Off-topic Conversation section and its content rule', () => {
    const p = buildSummaryPrompt('detailed');
    expect(p).toContain('## Off-topic Conversation');
    expect(p).toContain('OPENS or CLOSES');
    expect(p).toContain('Omit this section entirely if there was no such chatter;');
    expect(p).toContain('it MUST be the final section');
  });

  it('forbids duplicating off-topic chatter in the main sections', () => {
    const p = buildSummaryPrompt('detailed');
    expect(p).toContain('MOVES off-topic chatter out of the outline');
    expect(p).toContain('must NOT also appear in Overview, Key Discussion Points');
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
