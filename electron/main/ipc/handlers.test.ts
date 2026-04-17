import { describe, it, expect, vi } from 'vitest';
import { registerIpcHandlers } from './handlers';

describe('registerIpcHandlers', () => {
  it('registers all known channels', () => {
    const handle = vi.fn();
    const fakeIpc = { handle } as any;
    const services: any = {
      meetings: { listAll: () => [] },
      speakers: { list: () => [] },
      actionItems: { listByMeeting: () => [] },
      settings: { getAll: () => ({}), get: () => '', set: () => {} },
      lmStudio: { listModels: async () => [] },
      audioHijack: { startSession: async () => {}, stopSession: async () => {}, sessionState: async () => 'stopped' },
      roster: { confirmSpeaker: () => 'id', confirmSpeakerFor: () => {} },
      pipeline: { enqueue: () => {} },
      exporters: {},
      libraryRoot: '/tmp',
    };
    registerIpcHandlers(fakeIpc, services);
    const channels = handle.mock.calls.map((c) => c[0]);
    expect(channels).toContain('meetings:list');
    expect(channels).toContain('meetings:get');
    expect(channels).toContain('export:run');
    expect(channels).toContain('models:list');
  });
});
