export type CaptureLevelSource = 'mic' | 'system' | 'mixed';
export type CaptureWarning = 'app-silent' | 'mic-silent' | 'output-silent' | 'all-silent';

export interface CaptureHealth {
  state: 'checking' | 'healthy' | 'warning';
  warning?: CaptureWarning;
  message?: string;
  active: Record<CaptureLevelSource, boolean>;
}

export function deriveCaptureHealth(input: {
  startedAtMs: number;
  nowMs: number;
  lastAudibleAt: Partial<Record<CaptureLevelSource, number>>;
  graceMs?: number;
  windowMs?: number;
}): CaptureHealth {
  const graceMs = input.graceMs ?? 5_000;
  const windowMs = input.windowMs ?? 20_000;
  const active = Object.fromEntries(
    (['mic', 'system', 'mixed'] as const).map((source) => [
      source,
      input.lastAudibleAt[source] !== undefined
        && input.nowMs - input.lastAudibleAt[source]! <= windowMs,
    ]),
  ) as Record<CaptureLevelSource, boolean>;

  if (input.nowMs - input.startedAtMs < graceMs) return { state: 'checking', active };
  if (active.mic && active.system && active.mixed) return { state: 'healthy', active };
  if (active.mic && !active.system) {
    return {
      state: 'warning', warning: 'app-silent', active,
      message: 'Microphone is recording, but app audio is not detected.',
    };
  }
  if (active.system && !active.mic) {
    return {
      state: 'warning', warning: 'mic-silent', active,
      message: 'App audio is recording, but microphone audio is not detected.',
    };
  }
  if (active.mic && active.system && !active.mixed) {
    return {
      state: 'warning', warning: 'output-silent', active,
      message: 'Audio inputs are active, but the recording output is not updating.',
    };
  }
  return {
    state: 'warning', warning: 'all-silent', active,
    message: 'No microphone or app audio detected — check the selected source.',
  };
}

export function captureSummary(seen: ReadonlySet<CaptureLevelSource>): string {
  if (seen.has('mic') && seen.has('system')) return 'Captured microphone and app audio';
  if (seen.has('mic')) return 'Captured microphone audio only';
  if (seen.has('system')) return 'Captured app audio only';
  if (seen.has('mixed')) return 'Captured recording audio';
  return 'No audible audio was detected';
}
