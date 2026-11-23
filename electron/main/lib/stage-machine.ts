export const STAGES = [
  'discovered', 'transcribing', 'diarizing', 'merging',
  'identifying',
  // Gate where the pipeline pauses for the user to label unknown speakers
  // before summarize runs with `SPEAKER_00` placeholders baked into the
  // prompt. The pipeline only enters this stage if `skipSpeakerId` is false
  // on the meeting; otherwise it advances straight from identifying to
  // summarizing. No stage handler — it's a wait state, not work.
  'awaiting_speaker_id',
  'summarizing', 'extracting', 'done',
] as const;
export type Stage = (typeof STAGES)[number];

export const STATUSES = ['pending', 'processing', 'awaiting_user', 'done', 'failed'] as const;
export type Status = (typeof STATUSES)[number];

export function isStage(v: unknown): v is Stage {
  return typeof v === 'string' && (STAGES as readonly string[]).includes(v);
}

// On unclean shutdown, roll back any stage in the parallel block
// (transcribing/diarizing) to 'discovered' so both branches re-run together.
export function previousCompletedOnCrash(stage: Stage): Stage {
  if (stage === 'transcribing' || stage === 'diarizing') return 'discovered';
  return stage;
}
