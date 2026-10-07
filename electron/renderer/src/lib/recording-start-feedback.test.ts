import { describe, expect, it, vi } from 'vitest';
import { recordingStartFeedback, RECORDING_ACTIVE_MESSAGE } from './recording-start-feedback';

const busy = 'Already recording or stopping. Finish the active capture first.';
const wrapped = (message: string) => new Error(`Error invoking remote method 'recording:start': Error: ${message}`);

describe('recording start feedback', () => {
  it.each([new Error(busy), wrapped(busy), busy])('replaces duplicate-start transport errors with neutral guidance', async error => {
    const active = vi.fn(async () => [{ state: 'recording', disposable: false }]);
    expect(await recordingStartFeedback(error, { active })).toEqual({ kind: 'info', message: RECORDING_ACTIVE_MESSAGE });
    expect(active).toHaveBeenCalledOnce();
  });
  it.each([
    ['starting', 'Your recording is starting'],
    ['stopping', 'The previous recording is still stopping'],
  ])('uses authoritative %s state', async (state, message) => {
    expect(await recordingStartFeedback(wrapped(busy), { active: async () => [{ state, disposable: false }] }))
      .toMatchObject({ kind: 'info', message: expect.stringContaining(message) });
  });
  it('distinguishes disposable tests without claiming a Library recording exists', async () => {
    expect(await recordingStartFeedback(wrapped(busy), { active: async () => [{ state: 'recording', disposable: true }] }))
      .toMatchObject({ kind: 'info', message: expect.stringContaining('test recording') });
  });
  it.each([{ rows: [] }, { rows: [{ state: 'idle', disposable: false }] }, { rows: [{ state: 'unknown', disposable: false }] }])('does not guess when capture state has changed', async ({ rows }) => {
    expect(await recordingStartFeedback(wrapped(busy), { active: async () => rows }))
      .toEqual({ kind: 'info', message: 'Another recording is active or finishing. Check the recording controls before starting a new one.' });
  });
  it('handles failed state lookups without hiding the original duplicate or starting/stopping anything', async () => {
    const active = vi.fn(async () => { throw new Error('state unavailable'); });
    expect(await recordingStartFeedback(wrapped(busy), { active })).toMatchObject({ kind: 'info' });
    expect(active).toHaveBeenCalledOnce();
  });
  it.each([wrapped('Check microphone permissions.'), new Error('Check microphone permissions.')])('keeps real failures actionable without IPC jargon', async error => {
    const active = vi.fn();
    expect(await recordingStartFeedback(error, { active })).toEqual({ kind: 'error', message: 'Could not start recording. Check microphone permissions.' });
    expect(active).not.toHaveBeenCalled();
  });
  it('does not relabel a real error just because a recording could be active', async () => {
    const active = vi.fn(async () => [{ state: 'recording', disposable: false }]);
    expect(await recordingStartFeedback(wrapped('Recorder did not become ready within 15 seconds.'), { active }))
      .toMatchObject({ kind: 'error', message: expect.stringContaining('15 seconds') });
    expect(active).not.toHaveBeenCalled();
  });
  it.each([null, undefined, {}])('has a safe fallback for unknown thrown values', async error => {
    expect(await recordingStartFeedback(error, { active: vi.fn() }))
      .toEqual({ kind: 'error', message: 'Could not start recording. Please try again.' });
  });
});
