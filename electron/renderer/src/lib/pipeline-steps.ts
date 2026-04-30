// User-facing pipeline progress model. The internal state machine has more
// stages than the user wants to learn about — `transcribing`/`diarizing` run
// in parallel and read as one wait from the user's perspective; the
// merge/identify pair is similarly invisible. Collapsing to five labelled
// steps gives the LibraryRow chip and the MeetingDetailView timeline a
// single shared model so a meeting that says "PROCESSING 2/5" on the row
// shows up as step 2 of 5 in the detail view.
//
// Internal stages outside this map (`discovered`, `pending`, `done`) are
// pre/post-pipeline states; `stepIndexFor` returns -1 for them, which
// callers treat as "no active step yet" or "already past the last step"
// depending on context.
export const USER_STEPS = [
  'transcribe',
  'speaker ID',
  'name voices',
  'summarize',
  'extract',
] as const;

export type UserStep = (typeof USER_STEPS)[number];

const STAGE_TO_STEP: Record<string, UserStep> = {
  transcribing: 'transcribe',
  diarizing: 'transcribe',
  merging: 'speaker ID',
  identifying: 'speaker ID',
  awaiting_speaker_id: 'name voices',
  summarizing: 'summarize',
  extracting: 'extract',
};

export const TOTAL_USER_STEPS = USER_STEPS.length;

/** Index (0-based) into USER_STEPS for the given internal pipeline stage,
 *  or -1 if the stage is pre-pipeline (`discovered`/`pending`) or
 *  post-pipeline (`done`). */
export function stepIndexFor(pipelineStage: string): number {
  const step = STAGE_TO_STEP[pipelineStage];
  if (!step) return -1;
  return USER_STEPS.indexOf(step);
}
