// electron/renderer/src/lib/poll-gate.ts
//
// Decides whether the Library should hold the shared 3s meetings poll.
//
// The gate tracks ACTUAL pipeline activity — the same signal the bottom
// status bar uses (deriveStatusBar keys off currentId / queueLength) — not
// the mere presence of pending/awaiting rows in the meetings list. A
// `pending` recording just sits in the catalog until the user processes it;
// an `awaiting_user` meeting sits parked at the speaker-ID gate. Neither
// changes on its own — both surface via push events (meetings:added,
// pipeline:status) that already trigger a one-shot refresh. Polling for them
// re-ran the speakers JOIN + action-items aggregate every 3s forever while
// the status bar correctly read "Ready". Poll only when something is truly
// in flight (current or queued) or a live recording is running.

/** The pipeline fields the gate needs — a subset of PipelineStatusSnapshot. */
export interface PollPipelineStatus {
  currentId: string | null;
  queueLength: number;
}

export function shouldPollLibrary(
  status: PollPipelineStatus,
  hasLiveRecording: boolean,
): boolean {
  return hasLiveRecording || status.currentId !== null || status.queueLength > 0;
}
