import { describe, expect, it } from 'vitest';
import { buildDiagnosticsReport, DIAGNOSTICS_LOG_LINES } from './diagnostics-report';

const base = {
  version: '1.22.1', provider: 'lm-studio', model: 'qwen/qwen3.5-9b', llmUrl: 'http://127.0.0.1:1234',
  health: [{ label: 'Microphone', state: 'ready', detail: 'Permission granted' }],
  entries: [{ ts: '2026-11-23T10:00:00Z', level: 'warn', msg: 'recording:app-audio-stalled', data: { stalled_ms: 4000 } }],
  filterLabel: 'Warnings+', now: new Date('2026-11-23T12:00:00Z'),
};

describe('buildDiagnosticsReport', () => {
  it('includes version, provider, model, health and the filtered log', () => {
    const report = buildDiagnosticsReport(base);
    expect(report).toContain('MeetingNotes 1.22.1');
    expect(report).toContain('Copied 2026-11-23T12:00:00.000Z');
    expect(report).toContain('Provider: lm-studio');
    expect(report).toContain('Model: qwen/qwen3.5-9b');
    expect(report).toContain('Microphone: ready — Permission granted');
    expect(report).toContain('2026-11-23T10:00:00Z WARN recording:app-audio-stalled {"stalled_ms":4000}');
  });
  it('says so when nothing is selected or logged', () => {
    const report = buildDiagnosticsReport({ ...base, model: '', health: [], entries: [] });
    expect(report).toContain('Model: (none selected)');
    expect(report).toContain('(unavailable)');
    expect(report).toContain('(no entries at this level)');
  });
  it('caps the log at the newest lines', () => {
    const entries = Array.from({ length: DIAGNOSTICS_LOG_LINES + 50 }, (_, i) => ({ ts: null, level: 'info', msg: `line-${i}` }));
    const report = buildDiagnosticsReport({ ...base, entries });
    expect(report).toContain('line-0');
    expect(report).toContain(`line-${DIAGNOSTICS_LOG_LINES - 1}`);
    expect(report).not.toContain(`line-${DIAGNOSTICS_LOG_LINES}\n`);
  });
});
