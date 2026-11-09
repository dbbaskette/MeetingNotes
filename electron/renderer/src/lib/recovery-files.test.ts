import { describe, expect, it } from 'vitest';
import { describeRecoveryFile, discardSummary, fileRoleLabel, formatRecordedAt } from './recovery-files';

describe('recovery file labels', () => {
  it('names each capture file by what it holds', () => {
    expect(fileRoleLabel('combined')).toBe('Combined recording');
    expect(fileRoleLabel('microphone')).toBe('Your microphone');
    expect(fileRoleLabel('app')).toBe('App audio');
    expect(describeRecoveryFile({ name: 'x.voice.m4a', role: 'microphone', sizeBytes: 3 * 1024 * 1024 }))
      .toBe('Your microphone · 3.0 MB');
  });

  it('summarizes what a delete will move to the Trash', () => {
    expect(discardSummary([
      { name: 'a.m4a', role: 'combined', sizeBytes: 1024 * 1024 },
      { name: 'a.voice.m4a', role: 'microphone', sizeBytes: 1024 * 1024 },
    ])).toBe('2 files (2.0 MB) will move to the Trash. You can put them back from the Trash in Finder until you empty it.');
    expect(discardSummary([{ name: 'a.m4a', role: 'combined', sizeBytes: 2048 }])).toMatch(/^1 file \(2 KB\)/);
  });

  it('explains that a delete with no files left only clears the list entry', () => {
    expect(discardSummary([])).toMatch(/No files from this recording are left on disk/);
  });

  it('formats the recording start time and rejects unreadable dates', () => {
    // ICU puts a narrow no-break space before AM/PM; compare with plain spaces.
    expect(formatRecordedAt('2026-11-03T14:05:00', 'en-US')?.replace(/\s/g, ' ')).toBe('Tue, Nov 3, 2:05 PM');
    expect(formatRecordedAt('not a date')).toBeNull();
  });
});
