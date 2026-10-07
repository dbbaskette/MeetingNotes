export interface RecordingStartFeedback {
  kind: 'info' | 'error';
  message: string;
}

export const RECORDING_ACTIVE_MESSAGE = 'A recording is already active. Use Stop in the recording panel, or wait for it to finish, before starting another.';

/** Electron transports only the error message, adding its invoke wrapper.
 * Keep the backend's single-capture guard; an expected duplicate is guidance,
 * not a technical failure or permission to stop/restart the existing capture. */
export async function recordingStartFeedback(error: unknown, recording: {
  active: () => Promise<{ state: string; disposable: boolean }[]>;
}): Promise<RecordingStartFeedback> {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const message = raw.replace(/^Error invoking remote method ['"]recording:start['"]:\s*(?:Error:\s*)?/, '').trim();
  if (message !== 'Already recording or stopping. Finish the active capture first.') {
    return { kind: 'error', message: message ? `Could not start recording. ${message}` : 'Could not start recording. Please try again.' };
  }
  // A capture may have started elsewhere, or be finishing while the rejected
  // invoke returns. Ask the manager rather than assuming it is still running.
  try {
    const [active] = await recording.active();
    if (active?.disposable) return { kind: 'info', message: 'A test recording is in progress. Wait for the test to finish before starting a meeting recording.' };
    if (active?.state === 'starting') return { kind: 'info', message: 'Your recording is starting. Please wait — there is no need to press Record again.' };
    if (active?.state === 'stopping') return { kind: 'info', message: 'The previous recording is still stopping. Wait for it to finish, or retry Stop in the recording panel.' };
    if (active?.state === 'recording') return { kind: 'info', message: RECORDING_ACTIVE_MESSAGE };
  } catch { /* State unavailable: don't guess or disturb the existing capture. */ }
  return { kind: 'info', message: 'Another recording is active or finishing. Check the recording controls before starting a new one.' };
}
