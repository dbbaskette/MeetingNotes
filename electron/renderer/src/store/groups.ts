import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import { api } from '../ipc/client';

export type MeetingGroup = Awaited<ReturnType<typeof api.groups.list>>['groups'][number];
let refreshRevision = 0;

interface GroupsState {
  groups: MeetingGroup[];
  allCount: number;
  ungroupedCount: number;
  loaded: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  create: (name: string) => Promise<MeetingGroup>;
  rename: (id: string, name: string) => Promise<void>;
  delete: (id: string) => Promise<boolean>;
}

export const groupsStore = createStore<GroupsState>()((set, get) => ({
  groups: [], allCount: 0, ungroupedCount: 0, loaded: false, error: null,
  async refresh() {
    const revision = ++refreshRevision;
    try {
      const snapshot = await api.groups.list();
      if (revision === refreshRevision) set({ ...snapshot, loaded: true, error: null });
    } catch (error) {
      if (revision === refreshRevision) set({ loaded: true, error: (error as Error).message });
    }
  },
  async create(name) {
    const group = await api.groups.create(name);
    await get().refresh();
    return group;
  },
  async rename(id, name) {
    await api.groups.rename(id, name);
    await get().refresh();
  },
  async delete(id) {
    const deleted = await api.groups.delete(id);
    await get().refresh();
    return deleted;
  },
}));

export function useGroupsStore(): GroupsState {
  return useStore(groupsStore);
}
