import { describe, it, expect, vi } from 'vitest';
import { registerIpcHandlers } from './handlers.js';

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
      recordingManager: { start: async () => ({ sessionId: 's', outputPath: '/o' }), stop: async () => {}, state: () => 'idle', on: () => {} },
      appEnumerator: { list: async () => [] },
      helperPath: '/bin/meeting-notes-tap',
      roster: { confirmSpeaker: () => 'id', confirmSpeakerFor: () => {} },
      pipeline: {
        enqueue: () => {},
        getStatus: () => ({ paused: false, currentId: null, queueLength: 0, queueIds: [] }),
        pause: () => {},
        resume: () => {},
        clearQueue: () => [],
      },
      exporters: {},
      libraryRoot: '/tmp',
    };
    registerIpcHandlers(fakeIpc, services);
    const channels = handle.mock.calls.map((c) => c[0]);
    expect(channels).toContain('meetings:list');
    expect(channels).toContain('meetings:get');
    expect(channels).toContain('export:run');
    expect(channels).toContain('models:list');
    // New endpoints from the UX-review pass: Settings "Test connection"
    // probes (one per LLM/STT side) and the drag-and-drop import handler.
    expect(channels).toContain('stt:probe');
    expect(channels).toContain('llm:probe');
    expect(channels).toContain('meetings:import-dropped');
    expect(channels).toContain('transcript:export');
    // Queue controls (pause / resume / clear / status snapshot).
    expect(channels).toContain('pipeline:pause');
    expect(channels).toContain('pipeline:resume');
    expect(channels).toContain('pipeline:clear');
    expect(channels).toContain('pipeline:status');
  });
});
