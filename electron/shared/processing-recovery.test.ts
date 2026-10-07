import { describe, it, expect } from 'vitest';
import { processingDiagnosis, primaryProcessingStatus } from './processing-recovery.js';
describe('guided processing diagnosis', () => {
  it.each(['No whisper model installed', '403 gated model', 'ffprobe: moov atom not found', 'ECONNREFUSED', 'Metal OOM', 'unknown'])('provides plain diagnosis and action for %s', error => {
    const result = processingDiagnosis(error); expect(result.title).toBeTruthy(); expect(result.action).toBeTruthy();
    expect(result.title).not.toContain(error);
  });
  it('prioritizes failure over voices and advisories, without bypassing a gate', () => {
    expect(primaryProcessingStatus({ status: 'failed', pipelineStage: 'awaiting_speaker_id', summaryStale: true })).toBe('failure');
    expect(primaryProcessingStatus({ status: 'awaiting_user', pipelineStage: 'awaiting_speaker_id', summaryStale: true })).toBe('speaker');
    expect(primaryProcessingStatus({ status: 'done', pipelineStage: 'done', summaryStale: true })).toBe('advisory');
  });
});
