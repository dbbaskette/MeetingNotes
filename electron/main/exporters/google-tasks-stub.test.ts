import { describe, it, expect } from 'vitest';
import { GoogleTasksStub } from './google-tasks-stub.js';

describe('GoogleTasksStub', () => {
  it('throws NotImplemented so UI can surface "coming soon"', async () => {
    const exp = new GoogleTasksStub();
    await expect(exp.export({ items: [], meetingTitle: 'x', meetingFolder: '/' }))
      .rejects.toThrow(/not implemented/i);
  });
  it('name is "google-tasks"', () => { expect(new GoogleTasksStub().name).toBe('google-tasks'); });
});
