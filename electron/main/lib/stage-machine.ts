export const STAGES = [
  'discovered', 'transcribing', 'diarizing', 'merging',
  'identifying', 'summarizing', 'extracting', 'done',
] as const;
export type Stage = (typeof STAGES)[number];

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

export function previousCompletedOnCrash(stage: Stage): Stage {
  if (stage === 'transcribing' || stage === 'diarizing') return 'discovered';
  return stage;
}

export function downstreamOf(stage: Stage): Stage[] {
  const i = STAGES.indexOf(stage);
  return STAGES.slice(i + 1) as Stage[];
}
