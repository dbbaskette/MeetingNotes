import { expect, it } from 'vitest';
import { audioSourceLabel, groupAudioSources, type SourceItem } from './audio-source-groups';
it('groups by app without dropping any stream and gives helpers unambiguous labels', () => {
  const sources: SourceItem[] = [501,502].map(pid => ({ pid, ownerPid: 500, ownerName: 'Zoom', name: null, bundleId: null, isMeetingApp: true, isRunningOutput: true }));
  const groups = groupAudioSources(sources);
  expect(groups).toHaveLength(1);
  expect(groups[0]!.sources.map(s => s.pid)).toEqual([501,502]);
  expect(audioSourceLabel(sources[0]!)).toBe('Zoom — Audio stream (PID 501)');
});
it('keeps old-binary targets and unattributed background targets selectable', () => {
  const sources: SourceItem[] = [1,2].map(pid => ({ pid, name: null, bundleId: null, isMeetingApp: false, isRunningOutput: false }));
  expect(groupAudioSources(sources)).toHaveLength(2);
  expect(audioSourceLabel(sources[0]!)).toBe('PID 1');
});
