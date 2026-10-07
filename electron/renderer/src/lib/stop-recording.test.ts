import { describe, expect, it, vi } from 'vitest';
import { stopRecording } from './stop-recording';

describe('truthful Stop completion', () => {
  it('reports a successful stop once without unnecessary state lookup', async () => {
    const api = { stop: vi.fn(async () => {}), state: vi.fn(async () => 'idle') };
    expect(await stopRecording('s', api)).toEqual({ stopped: true });
    expect(api.stop).toHaveBeenCalledTimes(1); expect(api.state).not.toHaveBeenCalled();
  });
  it.each(['starting', 'recording', 'stopping'])('keeps controls for failed Stop with %s state', async state => {
    expect(await stopRecording('s', { stop: async () => { throw Error(); }, state: async () => state })).toMatchObject({ stopped: false });
  });
  it.each(['idle', 'error'])('reconciles terminal %s without claiming playable output', async state => {
    expect(await stopRecording('s', { stop: async () => { throw Error(); }, state: async () => state })).toMatchObject({ stopped: true, message: expect.stringContaining('usable audio') });
  });
  it('retains controls for unknown outcomes and succeeds on retry', async () => {
    const api = { stop: vi.fn().mockRejectedValueOnce(Error()).mockResolvedValue(undefined), state: async () => { throw Error(); } };
    expect(await stopRecording('s', api)).toMatchObject({ stopped: false });
    expect(await stopRecording('s', api)).toEqual({ stopped: true });
  });
});
