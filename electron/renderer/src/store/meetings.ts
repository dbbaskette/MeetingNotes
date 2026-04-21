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
  stageStartedAt: string | null;
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

function shallowEqual(a: MeetingSummary[], b: MeetingSummary[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (
      x.id !== y.id ||
      x.pipelineStage !== y.pipelineStage ||
      x.status !== y.status ||
      x.stageStartedAt !== y.stageStartedAt ||
      x.title !== y.title ||
      x.actionItemsCount !== y.actionItemsCount ||
      x.unidentifiedCount !== y.unidentifiedCount ||
      x.speakers.length !== y.speakers.length
    ) return false;
  }
  return true;
}

export const useMeetingsStore = create<MeetingsState>((set, get) => ({
  meetings: [],
  loading: false,
  refresh: async () => {
    const list = (await api.meetings.list()) as MeetingSummary[];
    if (shallowEqual(get().meetings, list)) return;
    set({ meetings: list });
  },
}));
