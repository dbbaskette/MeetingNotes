import { describe, expect, it, vi } from 'vitest';
import type { MeetingNotesApi } from './index';

const mock = vi.hoisted(() => ({ expose: vi.fn(), invoke: vi.fn(), on: vi.fn(), off: vi.fn() }));
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: mock.expose },
  ipcRenderer: { invoke: mock.invoke, on: mock.on, off: mock.off },
}));
import './index';
const api = mock.expose.mock.calls[0]![1] as MeetingNotesApi;

describe('recovery progress bridge', () => {
  it('isolates overlapping requests, orders partial results, and cleans up listeners', async () => {
    const finish: Array<(items: unknown[]) => void> = [];
    mock.invoke.mockImplementation(() => new Promise(resolve => finish.push(resolve)));
    const progressA = vi.fn(); const progressB = vi.fn();
    const a = api.recovery.list(progressA); const b = api.recovery.list(progressB);
    const idA = mock.invoke.mock.calls[0]![1]; const idB = mock.invoke.mock.calls[1]![1];
    const listenerA = mock.on.mock.calls[0]![1]; const listenerB = mock.on.mock.calls[1]![1];
    const emit = (requestId: string, index: number) => {
      const update = { requestId, index, item: { id: String(index) } };
      listenerA(null, update); listenerB(null, update);
    };
    emit(idA, 1); emit(idA, 0);
    expect(progressA.mock.calls.at(-1)![0]).toEqual([{ id: '0' }, { id: '1' }]);
    expect(progressB).not.toHaveBeenCalled();
    emit(idB, 0);
    expect(progressB).toHaveBeenCalledTimes(1);
    finish[0]!([]); finish[1]!([]); await Promise.all([a, b]);
    expect(mock.off).toHaveBeenCalledWith('recovery:item', listenerA);
    expect(mock.off).toHaveBeenCalledWith('recovery:item', listenerB);
  });

  it('removes the progress listener on failure and supports callers without progress', async () => {
    mock.invoke.mockRejectedValue(new Error('failed'));
    await expect(api.recovery.list(vi.fn())).rejects.toThrow('failed');
    expect(mock.off).toHaveBeenLastCalledWith('recovery:item', mock.on.mock.calls.at(-1)![1]);
    mock.on.mockClear(); mock.invoke.mockResolvedValue([]);
    expect(await api.recovery.list()).toEqual([]);
    expect(mock.on).not.toHaveBeenCalled();
  });
});
