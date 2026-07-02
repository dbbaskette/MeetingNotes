import { describe, it, expect } from 'vitest';
import { deriveStatusBar, statusBarText, type StatusBarMeeting } from './status-bar.js';

function meeting(over: Partial<StatusBarMeeting> = {}): StatusBarMeeting {
  return {
    id: 'm1',
    title: 'Q3 sync',
    pipelineStage: 'summarizing',
    stageStartedAt: '2026-07-01T00:00:00.000Z',
    stageEtaMs: 180_000,
    stageEtaRough: false,
    ...over,
  };
}

const idle = { paused: false, currentId: null, queueLength: 0, queueIds: [] };

describe('deriveStatusBar', () => {
  it('is hidden (null) when nothing is current and the queue is empty', () => {
    expect(deriveStatusBar([], idle)).toBeNull();
    expect(deriveStatusBar([], { ...idle, paused: true })).toBeNull();
  });

  it('builds a processing model from the current meeting', () => {
    const model = deriveStatusBar([meeting()], { paused: false, currentId: 'm1', queueLength: 2, queueIds: ['a', 'b'] });
    expect(model).toEqual({
      kind: 'processing',
      meetingId: 'm1',
      title: 'Q3 sync',
      stageLabel: 'Summarizing',
      stageStartedAt: '2026-07-01T00:00:00.000Z',
      etaMs: 180_000,
      etaRough: false,
      queued: 2,
    });
  });

  it('maps each work stage to a bar-friendly label, unknown → Processing', () => {
    const label = (stage: string) =>
      deriveStatusBar([meeting({ pipelineStage: stage })], { ...idle, currentId: 'm1' })!.stageLabel;
    expect(label('transcribing')).toBe('Transcribing');
    expect(label('diarizing')).toBe('Transcribing');
    expect(label('identifying')).toBe('Identifying speakers');
    expect(label('summarizing')).toBe('Summarizing');
    expect(label('extracting')).toBe('Extracting');
    expect(label('discovered')).toBe('Processing');
  });

  it('falls back to a "…" title when the current row has not landed yet', () => {
    const model = deriveStatusBar([], { ...idle, currentId: 'm1' })!;
    expect(model.title).toBe('…');
    expect(model.stageLabel).toBe('Processing');
    expect(model.etaMs).toBeNull();
  });

  it('is paused-kind when the queue is paused', () => {
    const model = deriveStatusBar([meeting()], { paused: true, currentId: 'm1', queueLength: 2, queueIds: [] })!;
    expect(model.kind).toBe('paused');
  });

  it('shows a queue-only model when nothing is current but items wait', () => {
    const model = deriveStatusBar([], { paused: false, currentId: null, queueLength: 3, queueIds: [] })!;
    expect(model).toMatchObject({ kind: 'processing', meetingId: null, title: null, queued: 3 });
  });
});

describe('statusBarText', () => {
  const base = deriveStatusBar([meeting()], { paused: false, currentId: 'm1', queueLength: 2, queueIds: [] })!;

  it('composes the full processing line', () => {
    expect(statusBarText(base, 17)).toBe('Summarizing "Q3 sync" — 17s · ~3m · 2 queued');
  });

  it('drops the elapsed segment when there is no elapsed time', () => {
    expect(statusBarText(base, null)).toBe('Summarizing "Q3 sync" — ~3m · 2 queued');
  });

  it('drops the queue suffix when the queue is empty', () => {
    const solo = deriveStatusBar([meeting()], { paused: false, currentId: 'm1', queueLength: 0, queueIds: [] })!;
    expect(statusBarText(solo, 17)).toBe('Summarizing "Q3 sync" — 17s · ~3m');
  });

  it('hedges a rough estimate and falls back to estimating…', () => {
    const rough = deriveStatusBar([meeting({ stageEtaRough: true })], { paused: false, currentId: 'm1', queueLength: 0, queueIds: [] })!;
    expect(statusBarText(rough, 17)).toBe('Summarizing "Q3 sync" — 17s · ~3m (rough)');
    const cold = deriveStatusBar([meeting({ stageEtaMs: null })], { paused: false, currentId: 'm1', queueLength: 0, queueIds: [] })!;
    expect(statusBarText(cold, 17)).toBe('Summarizing "Q3 sync" — 17s · estimating…');
  });

  it('composes the paused variants', () => {
    const finishing = deriveStatusBar([meeting()], { paused: true, currentId: 'm1', queueLength: 2, queueIds: [] })!;
    expect(statusBarText(finishing, 17)).toBe('Paused — finishing "Q3 sync" · 2 queued');
    const idlePaused = deriveStatusBar([], { paused: true, currentId: null, queueLength: 2, queueIds: [] })!;
    expect(statusBarText(idlePaused, null)).toBe('Paused — 2 queued');
  });

  it('composes the queue-only line', () => {
    const queued = deriveStatusBar([], { paused: false, currentId: null, queueLength: 2, queueIds: [] })!;
    expect(statusBarText(queued, null)).toBe('2 queued');
  });
});
