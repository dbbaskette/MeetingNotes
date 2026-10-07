import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ManagedServiceDeps } from '../lib/managed-service.js';
import { resolveWhisperEndpoint } from './endpoint.js';
import { createConfiguredWhisperSupervisor } from './supervisor.js';

describe('Whisper endpoint configuration', () => {
  it.each([
    ['http://127.0.0.1:9090', '127.0.0.1', 9090],
    ['http://localhost', 'localhost', 80],
    ['http://127.0.0.1:80', '127.0.0.1', 80],
    ['http://[::1]:8088/', '::1', 8088],
  ])('aligns local client and managed binding for %s', (url, host, port) => {
    expect(resolveWhisperEndpoint(url)).toEqual({ kind: 'managed', host, port });
  });
  it.each(['https://localhost', 'https://fixture.example:443', 'http://fixture.example:9000',
    'http://localhost:9000/proxy', 'http://localhost:9000/?api=fixture'])('never manages external/TLS/proxy endpoints: %s', async endpoint => {
    const spawn = vi.fn(); const healthProbe = vi.fn(); const findBinary = vi.fn();
    const supervisor = createConfiguredWhisperSupervisor({ endpoint, getModelId: () => 'medium.en', spawn, healthProbe, findBinary });
    await supervisor.ensureReady(); await supervisor.stop();
    expect(spawn).not.toHaveBeenCalled(); expect(healthProbe).not.toHaveBeenCalled();
    expect(findBinary).not.toHaveBeenCalled();
  });
  it.each(['not a URL', 'file:///fixture'])('defers invalid saved configuration until processing, not startup: %s', async endpoint => {
    const supervisor = createConfiguredWhisperSupervisor({ endpoint, getModelId: () => 'medium.en' });
    await expect(supervisor.ensureReady()).rejects.toThrow(/STT URL/);
    await supervisor.stop();
  });
  it('launches and shuts down the helper at the configured local endpoint', async () => {
    const proc = Object.assign(new EventEmitter(), {
      pid: 12346, stdout: new EventEmitter(), stderr: new EventEmitter(),
      kill: () => { setImmediate(() => proc.emit('exit', 0, null)); return true; },
    });
    const spawn = vi.fn(() => proc as unknown as ReturnType<ManagedServiceDeps['spawn']>);
    const probe = vi.fn().mockResolvedValueOnce({ ok: false }).mockResolvedValue({ ok: true });
    const supervisor = createConfiguredWhisperSupervisor({ endpoint: 'http://127.0.0.1:9090',
      getModelId: () => 'small.en', findBinary: () => '/fixture/whisper', resolveModel: () => '/fixture/model.bin',
      spawn, healthProbe: probe, startupPollIntervalMs: 5, idleShutdownMs: 0,
    });
    try {
      await supervisor.ensureReady();
      expect(spawn.mock.calls[0]?.[1]).toEqual(['--model', '/fixture/model.bin', '--host', '127.0.0.1', '--port', '9090']);
      expect(probe).toHaveBeenCalledWith('127.0.0.1', 9090);
    } finally { await supervisor.stop(); }
  });
  it('formats IPv6 health URLs without passing brackets to the bind address', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"status":"ok"}'));
    const supervisor = createConfiguredWhisperSupervisor({ endpoint: 'http://[::1]:9090', getModelId: () => 'small.en' });
    try {
      await supervisor.ensureReady();
      expect(fetcher.mock.calls[0]?.[0]).toBe('http://[::1]:9090/health');
    } finally { await supervisor.stop(); fetcher.mockRestore(); }
  });
});
