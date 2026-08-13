import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RecordingRecoveryService, revealPathInFinder } from './recovery.js';

describe('RecordingRecoveryService', () => {
  it('classifies and recovers a microphone-only recording without changing its stem', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-recovery-'));
    const primary = path.join(dir, 'recording.m4a');
    const voice = path.join(dir, 'recording.voice.m4a');
    fs.writeFileSync(primary, '');
    fs.writeFileSync(voice, 'voice data');
    const session = {
      id: 's1', helperPid: 1, targetPid: 2, targetLabel: 'Zoom', outputPath: primary,
      startedAt: '2026-08-12T14:00:00.000Z', finalizedAt: null, status: 'orphaned', dismissedAt: null,
    } as const;
    const catalog = vi.fn(async (audioPath: string) => ({ kind: 'added', meeting: { id: 'm1', audioPath } }));
    const service = new RecordingRecoveryService({
      sessions: { findRecoverable: () => [session], findById: () => session, dismissRecovery: vi.fn() } as any,
      meetings: { findByAudioPath: () => null } as any,
      probe: vi.fn(async (file: string) => {
        if (file === voice) return { durationS: 42 };
        throw new Error('no duration');
      }),
      catalog,
      reveal: vi.fn(),
    });

    const items = await service.list();
    expect(items).toMatchObject([{ id: 's1', reason: 'microphone-only', durationS: 42, canRecover: true }]);

    const recovered = await service.recover('s1');
    expect(recovered.meetingId).toBe('m1');
    const recoveredPath = catalog.mock.calls[0]![0];
    expect(recoveredPath).not.toBe(voice);
    expect(fs.readFileSync(voice, 'utf8')).toBe('voice data');
    expect(fs.readFileSync(recoveredPath, 'utf8')).toBe('voice data');
  });

  it('keeps an unreadable session visible with reveal and dismiss', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-recovery-bad-'));
    const primary = path.join(dir, 'bad.m4a');
    fs.writeFileSync(primary, 'broken');
    const dismissRecovery = vi.fn();
    const reveal = vi.fn();
    const session = {
      id: 'bad', helperPid: 1, targetPid: null, targetLabel: 'All system audio', outputPath: primary,
      startedAt: '2026-08-12T14:00:00.000Z', finalizedAt: null, status: 'error', dismissedAt: null,
    } as const;
    const service = new RecordingRecoveryService({
      sessions: { findRecoverable: () => [session], findById: () => session, dismissRecovery } as any,
      meetings: { findByAudioPath: () => null } as any,
      probe: vi.fn(async () => { throw new Error('invalid'); }),
      catalog: vi.fn(), reveal,
    });

    expect(await service.list()).toMatchObject([{ reason: 'unreadable', canRecover: false }]);
    await service.reveal('bad');
    service.dismiss('bad');
    expect(reveal).toHaveBeenCalledWith(primary);
    expect(dismissRecovery).toHaveBeenCalledWith('bad');
  });

  it('opens the containing folder when the original capture has gone missing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-recovery-missing-'));
    const showItemInFolder = vi.fn();
    const openPath = vi.fn(async () => '');

    await revealPathInFinder(path.join(dir, 'gone.m4a'), { showItemInFolder, openPath });

    expect(showItemInFolder).not.toHaveBeenCalled();
    expect(openPath).toHaveBeenCalledWith(dir);
  });
});
