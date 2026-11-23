import { describe, expect, it } from 'vitest';
import { canAskMeeting, citationAction } from './meeting-ask';
import { endpointNotice } from '../../../../shared/ask';

describe('citationAction', () => {
  it('seeks the player in place for a timed transcript passage', () => {
    expect(citationAction({ kind: 'transcript', startS: 754 })).toEqual({ kind: 'seek', seconds: 754, tab: 'transcript' });
    expect(citationAction({ kind: 'transcript', startS: 0 })).toEqual({ kind: 'seek', seconds: 0, tab: 'transcript' });
  });
  it('switches tabs for notes and for untimed transcript passages', () => {
    expect(citationAction({ kind: 'summary', startS: null })).toEqual({ kind: 'tab', tab: 'summary' });
    expect(citationAction({ kind: 'transcript', startS: null })).toEqual({ kind: 'tab', tab: 'transcript' });
  });
});

describe('canAskMeeting', () => {
  it('needs notes or a transcript', () => {
    expect(canAskMeeting({ summaryMd: '## Notes', transcriptMd: null })).toBe(true);
    expect(canAskMeeting({ summaryMd: null, transcriptMd: '[A 00:01] hi' })).toBe(true);
    expect(canAskMeeting({ summaryMd: '  ', transcriptMd: null })).toBe(false);
    expect(canAskMeeting({ summaryMd: null, transcriptMd: null })).toBe(false);
  });
});

describe('endpointNotice', () => {
  it('says the question stayed on this Mac for a local model', () => {
    expect(endpointNotice({ local: true }, true)).toMatch(/this Mac/);
  });
  it('names the remote host the question went to, and says when nothing was sent', () => {
    expect(endpointNotice({ local: false, host: 'llm.example.com' }, true)).toMatch(/sent to llm\.example\.com/);
    expect(endpointNotice({ local: false, host: 'llm.example.com' }, false)).toMatch(/^Nothing was sent to llm\.example\.com/);
  });
});
