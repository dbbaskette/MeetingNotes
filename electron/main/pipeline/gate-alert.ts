// electron/main/pipeline/gate-alert.ts
//
// Pure decision logic for the "awaiting speaker ID" gate alert. Kept free of
// Electron so it can be unit-tested; the actual native Notification call lives
// in index.ts. The `notified` set records which meetings we've already alerted
// for THIS entry into the gate, so we notify once per entry (spec: no nagging)
// and again only after a genuine re-entry (the flag is cleared when the meeting
// is unblocked — see the IPC handlers).

/** True iff we should fire a notification for this meeting entering the gate.
 *  Records the id as a side effect so the next call for the same visit returns
 *  false. */
export function shouldNotifyGate(meetingId: string, notified: Set<string>): boolean {
  if (notified.has(meetingId)) return false;
  notified.add(meetingId);
  return true;
}

/** Forget a meeting's notified state so a later re-entry into the gate alerts
 *  again. Called from the IPC handlers that move a meeting off the gate. */
export function clearGateNotified(meetingId: string, notified: Set<string>): void {
  notified.delete(meetingId);
}
