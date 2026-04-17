// electron/renderer/src/store/meetings.ts
import { create } from 'zustand';
import { api } from '../ipc/client';

interface MeetingSummary {
  id: string;
  slug: string;
  title: string;
  startedAt: string | null;
  durationS: number | null;
  pipelineStage: string;
  status: string;
  unidentifiedCount: number;
  actionItemsCount: number;
  speakers: {
    localLabel: string;
    rosterId: string | null;
    displayName: string | null;
    confidence: number | null;
  }[];
}

interface MeetingsState {
  meetings: MeetingSummary[];
  loading: boolean;
  refresh: () => Promise<void>;
}

export const useMeetingsStore = create<MeetingsState>((set) => ({
  meetings: [],
  loading: false,
  refresh: async () => {
    set({ loading: true });
    const list = (await api.meetings.list()) as MeetingSummary[];
    set({ meetings: list, loading: false });
  },
}));
