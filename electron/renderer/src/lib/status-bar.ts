// electron/renderer/src/lib/status-bar.ts
//
// PURE derivation for the app-wide bottom pipeline status bar. No React, no
// IPC, no clock — so every output string is unit-tested to the character and
// the component stays a dumb shell. Given the meeting summaries the store
// already holds plus the pipeline:status snapshot, decide whether the bar is
// visible and what it reads.

import { fmtEta } from './fmtEta.js';
import { fmtElapsed } from './useElapsed.js';
import { stepIndexFor, USER_STEPS } from './pipeline-steps.js';

/** The subset of a meeting summary the bar needs. Kept minimal so the pure
 *  module doesn't couple to the full store/IPC shape. */
export interface StatusBarMeeting {
  id: string;
  title: string;
  pipelineStage: string;
  stageStartedAt: string | null;
  stageEtaMs: number | null;
  stageEtaRough: boolean;
}

/** Mirror of the pipeline:status snapshot (see preload `pipeline.status`). */
export interface PipelineStatusSnapshot {
  paused: boolean;
  currentId: string | null;
  queueLength: number;
  queueIds: string[];
}

export interface StatusBarModel {
  /** 'paused' whenever the queue is paused; 'processing' otherwise (including
   *  the transient no-current-but-queued case). */
  kind: 'processing' | 'paused';
  /** Click target — the pipeline's currentId, or null when nothing is in
   *  flight (queue-only / paused-idle). */
  meetingId: string | null;
  title: string | null;
  stageLabel: string | null;
  stageStartedAt: string | null;
  etaMs: number | null;
  etaRough: boolean;
  queued: number;
}

/** Bar-friendly gerund per collapsed user step. "name voices" is deliberately
 *  absent — a meeting parked at the gate isn't the pipeline's current, and
 *  anything unmapped reads as the neutral "Processing". */
const STEP_LABEL: Partial<Record<(typeof USER_STEPS)[number], string>> = {
  transcribe: 'Transcribing',
  'speaker ID': 'Identifying speakers',
  summarize: 'Summarizing',
  extract: 'Extracting',
};

function stageLabelFor(pipelineStage: string | undefined): string {
  if (!pipelineStage) return 'Processing';
  const idx = stepIndexFor(pipelineStage);
  const step = idx >= 0 ? USER_STEPS[idx] : undefined;
  return (step && STEP_LABEL[step]) || 'Processing';
}

/** Build the status-bar model, or null when the bar should be hidden: nothing
 *  current AND an empty queue (a paused empty queue is a no-op, not news). */
export function deriveStatusBar(
  meetings: readonly StatusBarMeeting[],
  status: PipelineStatusSnapshot,
): StatusBarModel | null {
  if (!status.currentId && status.queueLength === 0) return null;
  const current = status.currentId
    ? meetings.find((m) => m.id === status.currentId) ?? null
    : null;
  const hasCurrent = status.currentId !== null;
  return {
    kind: status.paused ? 'paused' : 'processing',
    meetingId: status.currentId,
    // currentId set but the summary row hasn't landed yet → "…", same fallback
    // the QueueBanner uses.
    title: hasCurrent ? current?.title ?? '…' : null,
    stageLabel: hasCurrent ? stageLabelFor(current?.pipelineStage) : null,
    stageStartedAt: current?.stageStartedAt ?? null,
    etaMs: current?.stageEtaMs ?? null,
    etaRough: current?.stageEtaRough ?? false,
    queued: status.queueLength,
  };
}

/** Compose the one-line status string. `elapsedSeconds` comes from useElapsed
 *  (null when not ticking); the elapsed segment is dropped when it's null. */
export function statusBarText(model: StatusBarModel, elapsedSeconds: number | null): string {
  const queueSuffix = model.queued > 0 ? ` · ${model.queued} queued` : '';

  if (model.kind === 'paused') {
    return model.meetingId
      ? `Paused — finishing "${model.title}"${queueSuffix}`
      : `Paused — ${model.queued} queued`;
  }

  // Not paused, nothing actually running — just the waiting count.
  if (!model.meetingId) return `${model.queued} queued`;

  const segments: string[] = [];
  const elapsed = fmtElapsed(elapsedSeconds);
  if (elapsed) segments.push(elapsed);
  segments.push(fmtEta(model.etaMs, model.etaRough));
  if (model.queued > 0) segments.push(`${model.queued} queued`);
  return `${model.stageLabel} "${model.title}" — ${segments.join(' · ')}`;
}
