// electron/renderer/src/store/meetings.ts
import { useEffect } from 'react';
import { useStore } from 'zustand';
import { api } from '../ipc/client';
import { createPagedMeetings } from '../lib/paged-meetings';
import { createSharedInterval } from '../lib/shared-interval';

const meetingsStore = createPagedMeetings(api.meetings.listPage);
export const useMeetingsStore = Object.assign(
  () => useStore(meetingsStore),
  meetingsStore,
);

/** One shared cadence for "the pipeline is moving, keep the list fresh". */
export const MEETINGS_POLL_MS = 3000;

// Only Library holders refresh the loaded page prefix. The global pipeline
// bar hydrates its active IDs independently, including on non-Library views.
const meetingsPoll = createSharedInterval(
  () => { void useMeetingsStore.getState().refresh(); },
  MEETINGS_POLL_MS,
);

/** Hold the shared meetings poll while `active` is true. */
export function useMeetingsPoll(active: boolean): void {
  useEffect(() => (active ? meetingsPoll.acquire() : undefined), [active]);
}
