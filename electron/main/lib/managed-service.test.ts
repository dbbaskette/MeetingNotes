import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { ManagedService, type ProbeResult } from './managed-service.js';

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

const noProbe = async (): Promise<ProbeResult> => ({ ok: false });
const okProbe = async (): Promise<ProbeResult> => ({ ok: true });

const baseLaunch = (): { cmd: string; args: string[] } => ({ cmd: '/bin/true', args: [] });

describe('ManagedService.ensureReady', () => {
  it('spawns and waits for /health to return ok', async () => {
    const spawn = vi.fn(() => fakeProc() as any);
    let probeCalls = 0;
    const probe = async (): Promise<ProbeResult> => {
      probeCalls += 1;
      // First call (pre-flight adoption): not ok, fall through to spawn.
      // Subsequent (post-spawn poll): ok on the 3rd total call.
      return { ok: probeCalls >= 3 };
    };
    const svc = new ManagedService({
      name: 'test',
      port: 9000,
      spawn,
      resolveLaunch: baseLaunch,
      healthProbe: probe,
      startupPollIntervalMs: 5,
    });
    await svc.ensureReady();
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(svc.isRunning()).toBe(true);
    await svc.stop();
  });

  it('coalesces concurrent ensureReady() calls into one start', async () => {
    const spawn = vi.fn(() => fakeProc() as any);
    let probeCalls = 0;
    const probe = async (): Promise<ProbeResult> => {
      probeCalls += 1;
      return { ok: probeCalls >= 3 };
    };
    const svc = new ManagedService({
      name: 'test',
      port: 9001,
      spawn,
      resolveLaunch: baseLaunch,
      healthProbe: probe,
      startupPollIntervalMs: 5,
    });
    await Promise.all([svc.ensureReady(), svc.ensureReady(), svc.ensureReady()]);
    expect(spawn).toHaveBeenCalledTimes(1);
    await svc.stop();
  });

  it('adopts an externally-running instance instead of spawning', async () => {
    const spawn = vi.fn(() => fakeProc() as any);
    const svc = new ManagedService({
      name: 'test',
      port: 9002,
      spawn,
      resolveLaunch: baseLaunch,
      healthProbe: okProbe,
    });
    await svc.ensureReady();
    expect(spawn).not.toHaveBeenCalled();
    expect(svc.isRunning()).toBe(true);
    await svc.stop();
  });

  it('does not kill an externally-owned instance on stop()', async () => {
    const spawn = vi.fn(() => fakeProc() as any);
    const svc = new ManagedService({
      name: 'test',
      port: 9003,
      spawn,
      resolveLaunch: baseLaunch,
      healthProbe: okProbe,
    });
    await svc.ensureReady();
    await svc.stop();
    // No proc was ever spawned → no kill is needed; verify spawn wasn't called.
    expect(spawn).not.toHaveBeenCalled();
  });

  it('build_id mismatch kills the squatter and respawns', async () => {
    const spawn = vi.fn(() => fakeProc() as any);
    const killOnPort = vi.fn(async () => {});
    let calls = 0;
    const probe = async (): Promise<ProbeResult> => {
      calls += 1;
      // Pre-flight reports a stale build_id; later post-spawn polls return ok.
      if (calls === 1) return { ok: true, buildId: 'stale-abc' };
      return { ok: calls >= 3 };
    };
    const svc = new ManagedService({
      name: 'test',
      port: 9004,
      spawn,
      resolveLaunch: baseLaunch,
      healthProbe: probe,
      expectedBuildId: () => 'fresh-xyz',
      killOnPort,
      startupPollIntervalMs: 5,
    });
    await svc.ensureReady();
    expect(killOnPort).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledTimes(1);
    await svc.stop();
  });
});

describe('ManagedService idle shutdown', () => {
  it('stops the process after idleShutdownMs of no ensureReady calls', async () => {
    const proc = fakeProc();
    const spawn = vi.fn(() => proc as any);
    const stoppedPromise = new Promise<void>((resolve) => proc.on('exit', () => resolve()));
    const svc = new ManagedService({
      name: 'test',
      port: 9005,
      spawn,
      resolveLaunch: baseLaunch,
      healthProbe: async () => ({ ok: true }),
      idleShutdownMs: 30,
      startupPollIntervalMs: 5,
    });
    // External instance — adopted, not spawned. To test the timer firing
    // a real stop on a spawned process, force spawn by failing pre-probe.
    let calls = 0;
    const probeFailingFirst = async (): Promise<ProbeResult> => {
      calls += 1;
      return { ok: calls >= 2 }; // pre-flight fails, post-spawn succeeds
    };
    const svc2 = new ManagedService({
      name: 'test2',
      port: 9006,
      spawn,
      resolveLaunch: baseLaunch,
      healthProbe: probeFailingFirst,
      idleShutdownMs: 30,
      startupPollIntervalMs: 5,
    });
    await svc2.ensureReady();
    expect(svc2.isRunning()).toBe(true);
    // Wait past the idle threshold.
    await new Promise((r) => setTimeout(r, 80));
    await stoppedPromise;
    expect(svc2.isRunning()).toBe(false);
    await svc.stop();
  });

  it('idle timer resets on each ensureReady()', async () => {
    const proc = fakeProc();
    const spawn = vi.fn(() => proc as any);
    let calls = 0;
    const probe = async (): Promise<ProbeResult> => {
      calls += 1;
      return { ok: calls >= 2 };
    };
    const svc = new ManagedService({
      name: 'test',
      port: 9007,
      spawn,
      resolveLaunch: baseLaunch,
      healthProbe: probe,
      idleShutdownMs: 50,
      startupPollIntervalMs: 5,
    });
    await svc.ensureReady();
    // Tap ensureReady well within the idle window — the timer should
    // reset, the process should still be alive after the original
    // window would have expired.
    await new Promise((r) => setTimeout(r, 30));
    await svc.ensureReady();
    await new Promise((r) => setTimeout(r, 30));
    expect(svc.isRunning()).toBe(true);
    await svc.stop();
  });

  it('idleShutdownMs <= 0 disables the timer', async () => {
    const spawn = vi.fn(() => fakeProc() as any);
    let calls = 0;
    const probe = async (): Promise<ProbeResult> => {
      calls += 1;
      return { ok: calls >= 2 };
    };
    const svc = new ManagedService({
      name: 'test',
      port: 9008,
      spawn,
      resolveLaunch: baseLaunch,
      healthProbe: probe,
      idleShutdownMs: 0,
      startupPollIntervalMs: 5,
    });
    await svc.ensureReady();
    await new Promise((r) => setTimeout(r, 60));
    expect(svc.isRunning()).toBe(true);
    await svc.stop();
  });
});

describe('ManagedService restart logic', () => {
  it('restarts on unexpected exit, up to max retries', async () => {
    let procs = 0;
    const spawn = vi.fn(() => {
      procs += 1;
      const p = fakeProc();
      // Simulate the child exiting before /health ever returns ok.
      setImmediate(() => p.emit('exit', 1, null));
      return p as any;
    });
    const svc = new ManagedService({
      name: 'test',
      port: 9009,
      spawn,
      resolveLaunch: baseLaunch,
      healthProbe: noProbe,
      maxRestarts: 2,
      restartDelayMs: 0,
      startupTimeoutMs: 50,
      startupPollIntervalMs: 10,
    });
    // ensureReady will reject because the process keeps exiting.
    await svc.ensureReady().catch(() => {});
    // Allow scheduled restarts to fire.
    await new Promise((r) => setTimeout(r, 100));
    expect(procs).toBe(3); // initial + 2 retries
    await svc.stop();
  });

  it('flags port conflict and stops restart loop on EADDRINUSE without an adoptable instance', async () => {
    let procs = 0;
    const spawn = vi.fn(() => {
      procs += 1;
      const p = fakeProc();
      setImmediate(() => {
        p.stderr.emit('data', Buffer.from('ERROR: [Errno 48] address already in use'));
        p.emit('exit', 1, null);
      });
      return p as any;
    });
    const svc = new ManagedService({
      name: 'test',
      port: 9010,
      spawn,
      resolveLaunch: baseLaunch,
      healthProbe: noProbe,
      maxRestarts: 5,
      restartDelayMs: 0,
      startupTimeoutMs: 50,
      startupPollIntervalMs: 10,
    });
    await svc.ensureReady().catch(() => {});
    await new Promise((r) => setTimeout(r, 60));
    expect(procs).toBe(1); // never restarted
    expect(svc.hasPortConflict()).toBe(true);
    await svc.stop();
  });
});
