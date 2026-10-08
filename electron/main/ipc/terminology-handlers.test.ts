import { describe, expect, it, vi } from 'vitest';
import type { IpcMain } from 'electron';
import type { TerminologyService } from '../terminology/service.js';
import { registerTerminologyHandlers } from './terminology-handlers.js';

function fixture() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const service = { preview: vi.fn(), commit: vi.fn(), undo: vi.fn(), undoMeeting: vi.fn() };
  registerTerminologyHandlers(
    {
      handle: (name: string, handler: (...args: unknown[]) => unknown) =>
        handlers.set(name, handler),
    } as unknown as IpcMain,
    service as unknown as TerminologyService,
  );
  return {
    service,
    invoke: (name: string, input: unknown) => handlers.get(`terminology:${name}`)!(null, input),
  };
}
describe('terminology IPC scope compatibility', () => {
  it('routes meeting preview/apply/grouped Undo while retaining per-document calls', () => {
    const { service, invoke } = fixture();
    const target = { meetingId: 'm', artifact: 'meeting' };
    invoke('preview', target);
    expect(service.preview).toHaveBeenCalledWith(target);
    const commit = { ...target, revision: 'a'.repeat(64), keys: ['transcript/key', 'summary/key'] };
    invoke('commit', commit);
    expect(service.commit).toHaveBeenCalledWith(commit);
    invoke('undo', { ...target, historyId: 'transcript/h', revision: commit.revision });
    expect(service.undoMeeting).toHaveBeenCalledWith('m', 'transcript/h', commit.revision);
    invoke('undo', { ...target, artifact: 'summary', historyId: 'h', revision: commit.revision });
    expect(service.undo).toHaveBeenCalledWith('m', 'summary', 'h', commit.revision);
  });
  it('rejects unknown scopes and oversized combined selections at the boundary', () => {
    const { service, invoke } = fixture();
    expect(() => invoke('preview', { meetingId: 'm', artifact: 'library' })).toThrow();
    expect(() =>
      invoke('commit', {
        meetingId: 'm',
        artifact: 'meeting',
        revision: 'a'.repeat(64),
        keys: Array(4001).fill('key'),
      }),
    ).toThrow();
    expect(service.preview).not.toHaveBeenCalled();
    expect(service.commit).not.toHaveBeenCalled();
  });
});
