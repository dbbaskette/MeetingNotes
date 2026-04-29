// electron/main/diarization/supervisor.test.ts
//
// Regression tests for the pyannote-specific factory. The lifecycle
// machinery itself (spawn, restart, adopt, idle shutdown) is covered
// by lib/managed-service.test.ts — this file only verifies the bits
// that live in supervisor.ts (HF_TOKEN injection, venv vs bundled
// resolution, BUILD_ID read).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDiarizationSupervisor } from './supervisor.js';

function fakeProc(): EventEmitter & {
  kill: (sig?: string) => void;
  pid: number;
  stdout: EventEmitter;
  stderr: EventEmitter;
} {
  const ee = new EventEmitter() as EventEmitter & {
    kill: (sig?: string) => void;
    pid: number;
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  ee.stdout = new EventEmitter();
  ee.stderr = new EventEmitter();
  ee.kill = () => setImmediate(() => ee.emit('exit', 0, null));
  ee.pid = 12345;
  return ee;
}

const okProbe = async (): Promise<{ ok: boolean }> => ({ ok: true });

describe('createDiarizationSupervisor', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-test-'));
  });

  it('adopts an existing healthy instance instead of spawning', async () => {
    const spawn = vi.fn(() => fakeProc() as any);
    const sup = createDiarizationSupervisor({
      sidecarDir: tmpDir,
      spawn,
      healthProbe: okProbe,
    });
    await sup.ensureReady();
    expect(spawn).not.toHaveBeenCalled();
    expect(sup.isRunning()).toBe(true);
    await sup.stop();
  });

  it('uses the venv python when sidecar/.venv/bin/python exists', async () => {
    const venvBin = path.join(tmpDir, '.venv', 'bin');
    fs.mkdirSync(venvBin, { recursive: true });
    fs.writeFileSync(path.join(venvBin, 'python'), '');
    let probeCalls = 0;
    const probe = async (): Promise<{ ok: boolean }> => {
      probeCalls += 1;
      return { ok: probeCalls >= 2 };
    };
    const spawn = vi.fn(() => fakeProc() as any);
    const sup = createDiarizationSupervisor({
      sidecarDir: tmpDir,
      spawn,
      healthProbe: probe,
      startupPollIntervalMs: 5,
      idleShutdownMs: 0,
    });
    await sup.ensureReady();
    expect(spawn).toHaveBeenCalledTimes(1);
    const [cmd, args] = spawn.mock.calls[0];
    expect(cmd).toBe(path.join(venvBin, 'python'));
    expect(args).toContain('uvicorn');
    expect(args).toContain('meeting_notes_diarize.app:app');
    await sup.stop();
  });

  it('falls back to bundled binary when no venv is present', async () => {
    let probeCalls = 0;
    const probe = async (): Promise<{ ok: boolean }> => {
      probeCalls += 1;
      return { ok: probeCalls >= 2 };
    };
    const spawn = vi.fn(() => fakeProc() as any);
    const sup = createDiarizationSupervisor({
      sidecarDir: tmpDir,
      spawn,
      healthProbe: probe,
      startupPollIntervalMs: 5,
      idleShutdownMs: 0,
    });
    await sup.ensureReady();
    expect(spawn).toHaveBeenCalledTimes(1);
    const [cmd] = spawn.mock.calls[0];
    expect(cmd).toBe(path.join(tmpDir, 'dist', 'meeting-notes-diarize', 'meeting-notes-diarize'));
    await sup.stop();
  });

  it('injects HF_TOKEN from env into the spawned child', async () => {
    process.env.HF_TOKEN = 'test-token-123';
    let probeCalls = 0;
    const probe = async (): Promise<{ ok: boolean }> => {
      probeCalls += 1;
      return { ok: probeCalls >= 2 };
    };
    const spawn = vi.fn(() => fakeProc() as any);
    try {
      const sup = createDiarizationSupervisor({
        sidecarDir: tmpDir,
        spawn,
        healthProbe: probe,
        startupPollIntervalMs: 5,
        idleShutdownMs: 0,
      });
      await sup.ensureReady();
      const [, , spawnOpts] = spawn.mock.calls[0];
      expect(spawnOpts.env.HF_TOKEN).toBe('test-token-123');
      await sup.stop();
    } finally {
      delete process.env.HF_TOKEN;
    }
  });

  it('reads expected build_id from sidecarDir/BUILD_ID for stale-vs-fresh adoption', async () => {
    fs.writeFileSync(path.join(tmpDir, 'BUILD_ID'), 'fresh-xyz\n');
    const killOnPort = vi.fn(async () => {});
    let probeCalls = 0;
    const probe = async (): Promise<{ ok: boolean; buildId?: string }> => {
      probeCalls += 1;
      // Pre-flight: stale instance running. Post-spawn: healthy.
      if (probeCalls === 1) return { ok: true, buildId: 'stale-abc' };
      return { ok: probeCalls >= 3 };
    };
    const spawn = vi.fn(() => fakeProc() as any);
    // We can't pass killOnPort through the factory — instead we
    // verify the side effect: spawn is invoked because the build_id
    // mismatch forces a respawn. In production the default
    // killOnPort frees the port; in this test we accept that the
    // shell-out is a no-op (no real port held).
    const sup = createDiarizationSupervisor({
      sidecarDir: tmpDir,
      spawn,
      healthProbe: probe,
      startupPollIntervalMs: 5,
      idleShutdownMs: 0,
    });
    await sup.ensureReady();
    expect(spawn).toHaveBeenCalledTimes(1);
    await sup.stop();
  });
});
