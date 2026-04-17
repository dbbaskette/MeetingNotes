import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { DiarizationSupervisor } from './supervisor';

function fakeProc() {
  const ee = new EventEmitter() as EventEmitter & { kill: () => void; pid: number };
  ee.kill = () => setImmediate(() => ee.emit('exit', 0, null));
  ee.pid = 12345;
  return ee;
}

describe('DiarizationSupervisor', () => {
  it('spawns the sidecar on start()', () => {
    const spawn = vi.fn(() => fakeProc() as any);
    const sup = new DiarizationSupervisor({ spawn, sidecarDir: '/tmp' });
    sup.start();
    expect(spawn).toHaveBeenCalledTimes(1);
    sup.stop();
  });

  it('restarts on unexpected exit, up to max retries', async () => {
    let procs = 0;
    const spawn = vi.fn(() => {
      procs += 1;
      const p = fakeProc();
      setImmediate(() => p.emit('exit', 1, null));
      return p as any;
    });
    const sup = new DiarizationSupervisor({ spawn, sidecarDir: '/tmp', maxRestarts: 2, restartDelayMs: 0 });
    sup.start();
    await new Promise((r) => setTimeout(r, 50));
    expect(procs).toBe(3); // initial + 2 restarts
    sup.stop();
  });
});
