import { describe, expect, it } from 'vitest';
import { EXPORT_TARGETS, exportTarget } from './export-targets.js';

describe('export target metadata', () => {
  it('keeps file and task selection policies explicit', () => {
    expect(EXPORT_TARGETS.pdf).toMatchObject({ kind: 'file', extension: 'pdf', allowsEmptySelection: true });
    expect(EXPORT_TARGETS.markdown).toMatchObject({ kind: 'file', extension: 'md', allowsEmptySelection: true });
    expect(EXPORT_TARGETS.reminders).toMatchObject({ kind: 'task', ownOpenItemsOnly: true, allowsEmptySelection: false });
    expect(EXPORT_TARGETS['google-tasks']).toMatchObject({ kind: 'task', ownOpenItemsOnly: true, requiresGoogle: true });
    expect(EXPORT_TARGETS['google-doc']).toMatchObject({ kind: 'document', allowsEmptySelection: true, requiresGoogle: true });
  });

  it('rejects unknown and inherited names', () => {
    expect(exportTarget('missing')).toBeNull();
    expect(exportTarget('toString')).toBeNull();
  });
});
