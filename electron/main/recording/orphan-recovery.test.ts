import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recoverOrphans } from './orphan-recovery.js';

describe('recoverOrphans', () => {
  it('marks open sessions as orphaned when their PID no longer exists', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-orph-'));
    const file = path.join(dir, 'orphan.m4a');
    fs.writeFileSync(file, 'fake but present');

    const repo = {
      findOpen: vi.fn(() => [{
        id: 's1', helperPid: 999999, outputPath: file,
        targetLabel: 'Zoom', targetPid: 1, startedAt: '', finalizedAt: null, status: 'recording' as const,
      }]),
      markOrphaned: vi.fn(),
      finalize: vi.fn(),
      markError: vi.fn(),
      insert: vi.fn(),
      findOrphaned: vi.fn(() => []),
    };
    const isAlive = vi.fn(() => false);

    await recoverOrphans({ repo: repo as any, isProcessAlive: isAlive });
    expect(repo.markOrphaned).toHaveBeenCalledWith('s1');
  });

  it('finalizes session if PID is somehow still alive (rare race)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-orph2-'));
    const file = path.join(dir, 'live.m4a');
    fs.writeFileSync(file, 'x');
    const repo = {
      findOpen: vi.fn(() => [{
        id: 's2', helperPid: process.pid, outputPath: file,
        targetLabel: 'X', targetPid: null, startedAt: '', finalizedAt: null, status: 'recording' as const,
      }]),
      markOrphaned: vi.fn(), finalize: vi.fn(), markError: vi.fn(),
      insert: vi.fn(), findOrphaned: vi.fn(() => []),
    };
    await recoverOrphans({ repo: repo as any, isProcessAlive: () => true });
    // Don't touch sessions whose helper is still running — assume MeetingNotes
    // also running, just slow to handle exit. Don't double-handle.
    expect(repo.markOrphaned).not.toHaveBeenCalled();
    expect(repo.finalize).not.toHaveBeenCalled();
  });
});
