import { describe, expect, it, vi } from 'vitest';

const list = vi.fn();
vi.mock('../ipc/client', () => ({ api: { groups: { list: (...args: unknown[]) => list(...args) } } }));

const snapshot = (name: string) => ({
  groups: [{ id: 'g1', name }], allCount: 3, ungroupedCount: 1,
});

describe('groups store', () => {
  it('keeps the previous references when a refresh returns identical groups', async () => {
    const { groupsStore } = await import('./groups');
    list.mockResolvedValue(snapshot('Team'));
    await groupsStore.getState().refresh();
    const first = groupsStore.getState();
    expect(first.loaded).toBe(true);

    const notified = vi.fn();
    const off = groupsStore.subscribe(notified);
    list.mockResolvedValue(snapshot('Team'));
    await groupsStore.getState().refresh();
    expect(notified).not.toHaveBeenCalled();
    expect(groupsStore.getState().groups).toBe(first.groups);

    list.mockResolvedValue(snapshot('Renamed'));
    await groupsStore.getState().refresh();
    expect(notified).toHaveBeenCalledTimes(1);
    expect(groupsStore.getState().groups[0]!.name).toBe('Renamed');
    off();
  });

  it('publishes again after an error even if the groups are unchanged', async () => {
    const { groupsStore } = await import('./groups');
    list.mockResolvedValue(snapshot('Stable'));
    await groupsStore.getState().refresh();
    list.mockRejectedValue(new Error('offline'));
    await groupsStore.getState().refresh();
    expect(groupsStore.getState().error).toBe('offline');
    list.mockResolvedValue(snapshot('Stable'));
    await groupsStore.getState().refresh();
    expect(groupsStore.getState().error).toBeNull();
  });
});
