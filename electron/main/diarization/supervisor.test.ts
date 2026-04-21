import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { DiarizationSupervisor } from './supervisor.js';

function fakeProc() {
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

const noProbe = async (): Promise<{ ok: boolean; buildId: string }> =>
  ({ ok: false, buildId: '' }); // never reuse — always spawn

describe('DiarizationSupervisor', () => {
  it('spawns the sidecar on start()', async () => {
    const spawn = vi.fn(() => fakeProc() as any);
    const sup = new DiarizationSupervisor({ spawn, sidecarDir: '/tmp', healthProbe: noProbe });
    await sup.start();
    expect(spawn).toHaveBeenCalledTimes(1);
    await sup.stop();
  });

  it('restarts on unexpected exit, up to max retries', async () => {
    let procs = 0;
    const spawn = vi.fn(() => {
      procs += 1;
      const p = fakeProc();
      setImmediate(() => p.emit('exit', 1, null));
      return p as any;
    });
    const sup = new DiarizationSupervisor({
      spawn, sidecarDir: '/tmp', maxRestarts: 2, restartDelayMs: 0, healthProbe: noProbe,
    });
    await sup.start();
    await new Promise((r) => setTimeout(r, 50));
    expect(procs).toBe(3); // initial + 2 restarts
    await sup.stop();
  });

  it('reuses an existing healthy instance instead of spawning', async () => {
    const spawn = vi.fn(() => fakeProc() as any);
    const sup = new DiarizationSupervisor({
      spawn, sidecarDir: '/tmp', healthProbe: async () => ({ ok: true, buildId: '' }),
    });
    await sup.start();
    expect(spawn).not.toHaveBeenCalled();
    expect(sup.isRunning()).toBe(true);
    await sup.stop();
  });

  it('stops restart loop when port is held by foreign process', async () => {
    let procs = 0;
    const spawn = vi.fn(() => {
      procs += 1;
      const p = fakeProc();
      // Simulate uvicorn's EADDRINUSE log line, then the process exits.
      setImmediate(() => {
        p.stderr.emit('data', Buffer.from('ERROR: [Errno 48] address already in use'));
        p.emit('exit', 1, null);
      });
      return p as any;
    });
    const sup = new DiarizationSupervisor({
      spawn, sidecarDir: '/tmp', maxRestarts: 5, restartDelayMs: 0,
      healthProbe: async () => ({ ok: false, buildId: '' }), // foreign owner, not a sidecar
    });
    await sup.start();
    await new Promise((r) => setTimeout(r, 50));
    expect(procs).toBe(1); // never restarted
    expect(sup.hasPortConflict()).toBe(true);
    await sup.stop();
  });
});
