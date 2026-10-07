import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { MeetingsRepo } from '../storage/meetings-repo.js';
import type { RecordingSessionsRepo } from '../storage/recording-sessions-repo.js';
import { RecordingRecoveryService, revealPathInFinder } from './recovery.js';

const fixtureDirs: string[] = [];
function fixtureDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fixtureDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of fixtureDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('RecordingRecoveryService', () => {
  it('classifies and recovers a microphone-only recording without changing its stem', async () => {
    const dir = fixtureDir('mn-recovery-');
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
      sessions: { findRecoverable: () => [session], findById: () => session, dismissRecovery: vi.fn() } as unknown as RecordingSessionsRepo,
      meetings: { findByAudioPath: () => null } as unknown as MeetingsRepo,
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
    const dir = fixtureDir('mn-recovery-bad-');
    const primary = path.join(dir, 'bad.m4a');
    fs.writeFileSync(primary, 'broken');
    const dismissRecovery = vi.fn();
    const reveal = vi.fn();
    const session = {
      id: 'bad', helperPid: 1, targetPid: null, targetLabel: 'All system audio', outputPath: primary,
      startedAt: '2026-08-12T14:00:00.000Z', finalizedAt: null, status: 'error', dismissedAt: null,
    } as const;
    const service = new RecordingRecoveryService({
      sessions: { findRecoverable: () => [session], findById: () => session, dismissRecovery } as unknown as RecordingSessionsRepo,
      meetings: { findByAudioPath: () => null } as unknown as MeetingsRepo,
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
    const dir = fixtureDir('mn-recovery-missing-');
    const showItemInFolder = vi.fn();
    const openPath = vi.fn(async () => '');

    await revealPathInFinder(path.join(dir, 'gone.m4a'), { showItemInFolder, openPath });

    expect(showItemInFolder).not.toHaveBeenCalled();
    expect(openPath).toHaveBeenCalledWith(dir);
  });

  it('reveals an existing recording without opening its parent or changing its audio', async () => {
    const dir = fixtureDir('mn-recovery-reveal-');
    const file = path.join(dir, 'recording with spaces.m4a');
    fs.writeFileSync(file, 'original audio');
    const showItemInFolder = vi.fn();
    const openPath = vi.fn(async () => '');
    await revealPathInFinder(file, { showItemInFolder, openPath });
    expect(showItemInFolder).toHaveBeenCalledWith(file);
    expect(openPath).not.toHaveBeenCalled();
    expect(fs.readFileSync(file, 'utf8')).toBe('original audio');
  });

  it('reports Electron folder-open errors, including a missing containing folder', async () => {
    const dir = fixtureDir('mn-recovery-open-error-');
    const folder = path.join(dir, 'removed-folder');
    const showItemInFolder = vi.fn();
    const openPath = vi.fn(async () => 'The folder does not exist');
    await expect(revealPathInFinder(path.join(folder, 'gone.m4a'), { showItemInFolder, openPath }))
      .rejects.toThrow('Could not open the recording folder in Finder: The folder does not exist');
    expect(showItemInFolder).not.toHaveBeenCalled();
    expect(openPath).toHaveBeenCalledWith(folder);
  });

  it('propagates rejected folder-open requests', async () => {
    const dir = fixtureDir('mn-recovery-open-rejected-');
    await expect(revealPathInFinder(path.join(dir, 'gone.m4a'), {
      showItemInFolder: vi.fn(), openPath: vi.fn(async () => { throw new Error('Finder unavailable'); }),
    })).rejects.toThrow('Finder unavailable');
  });

  it('does not dismiss a recovery item when Finder fails', async () => {
    const dir = fixtureDir('mn-recovery-reveal-failed-');
    const dismissRecovery = vi.fn();
    const session = { id: 'failed', outputPath: path.join(dir, 'gone.m4a'), dismissedAt: null };
    const service = new RecordingRecoveryService({
      sessions: { findById: (id: string) => id === session.id ? session : null, dismissRecovery } as unknown as RecordingSessionsRepo,
      meetings: {} as unknown as MeetingsRepo, catalog: vi.fn(),
      reveal: async () => { throw new Error('Finder unavailable'); },
    });
    await expect(service.reveal('failed')).rejects.toThrow('Finder unavailable');
    expect(dismissRecovery).not.toHaveBeenCalled();
    await expect(service.reveal('missing')).rejects.toThrow('Recovery item not found');
  });
});
