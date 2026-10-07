export type StopOutcome = { stopped: true; message?: string } | { stopped: false; message: string };

/** A failed invoke is not proof that capture ended. Reconcile independently;
 * terminal state permits clearing, unknown/active state keeps controls. */
export async function stopRecording(sessionId: string, recording: {
  stop: (id: string) => Promise<unknown>;
  state: (id: string) => Promise<string>;
}): Promise<StopOutcome> {
  try { await recording.stop(sessionId); return { stopped: true }; }
  catch {
    try {
      const state = await recording.state(sessionId);
      if (state === 'idle' || state === 'error') return {
        stopped: true, message: 'The recorder is no longer active. Check Library or Needs attention for usable audio.',
      };
    } catch { /* unknown outcome: keep controls */ }
    return { stopped: false, message: 'Could not confirm Stop. Recording may still be active. Retry Stop before starting another capture.' };
  }
}
