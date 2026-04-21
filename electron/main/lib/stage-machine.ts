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

export function nextStage(s: Stage): Stage | null {
  const i = STAGES.indexOf(s);
  if (i < 0 || i === STAGES.length - 1) return null;
  return STAGES[i + 1]!;
}

export function isValidTransition(from: Stage, to: Stage): boolean {
  const fi = STAGES.indexOf(from);
  const ti = STAGES.indexOf(to);
  if (fi < 0 || ti < 0) return false;
  if (ti <= fi) return true;
  return ti === fi + 1;
}

// On unclean shutdown, roll back any stage in the parallel block
// (transcribing/diarizing) to 'discovered' so both branches re-run together.
export function previousCompletedOnCrash(stage: Stage): Stage {
  if (stage === 'transcribing' || stage === 'diarizing') return 'discovered';
  return stage;
}

export function downstreamOf(stage: Stage): Stage[] {
  const i = STAGES.indexOf(stage);
  return STAGES.slice(i + 1) as Stage[];
}
