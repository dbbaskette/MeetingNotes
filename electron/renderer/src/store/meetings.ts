// electron/renderer/src/store/meetings.ts
import { useEffect } from 'react';
import { create } from 'zustand';
import { api } from '../ipc/client';
import { recycleMeetings } from '../lib/meetings-recycle';
import { createSharedInterval } from '../lib/shared-interval';

interface MeetingSummary {
  id: string;
  slug: string;
  title: string;
  startedAt: string | null;
  durationS: number | null;
  pipelineStage: string;
  status: string;
  stageStartedAt: string | null;
  stageEtaMs: number | null;
  stageEtaRough: boolean;
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

export const useMeetingsStore = create<MeetingsState>((set, get) => ({
  meetings: [],
  loading: false,
  refresh: async () => {
    const list = (await api.meetings.list()) as MeetingSummary[];
    // Recycle unchanged rows so they keep referential identity across
    // polls — that's what lets a memoized LibraryRow skip re-rendering
    // while some *other* meeting is moving through the pipeline. When
    // nothing changed at all, recycleMeetings returns the previous array
    // and we skip the set entirely.
    const prev = get().meetings;
    const next = recycleMeetings(prev, list);
    if (next !== prev) set({ meetings: next });
  },
}));

/** One shared cadence for "the pipeline is moving, keep the list fresh". */
export const MEETINGS_POLL_MS = 3000;

// Single app-wide poll loop. LibraryView (while there's motion) and the
// bottom PipelineStatusBar (while processing) both want the same refresh on
// the same cadence — ref-counting keeps overlapping holders from doubling
// the meetings:list IPC + DB work.
const meetingsPoll = createSharedInterval(
  () => { void useMeetingsStore.getState().refresh(); },
  MEETINGS_POLL_MS,
);

/** Hold the shared meetings poll while `active` is true. */
export function useMeetingsPoll(active: boolean): void {
  useEffect(() => (active ? meetingsPoll.acquire() : undefined), [active]);
}
