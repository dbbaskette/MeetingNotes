import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { LLMSupervisor } from './supervisor.js';

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
  ee.pid = 42;
  return ee;
}

describe('LLMSupervisor', () => {
  it('ensureReady is a no-op when provider is "external"', async () => {
    const spawn = vi.fn(() => fakeProc() as any);
    const sup = new LLMSupervisor({
      getProvider: () => 'external',
      spawn,
      findLmsBinary: () => '/fake/lms',
      findOllamaBinary: () => '/fake/ollama',
      lmStudioProbe: async () => ({ ok: false }),
      ollamaProbe: async () => ({ ok: false }),
    });
    await sup.ensureReady();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('lm-studio mode adopts an existing healthy server without spawning', async () => {
    const spawn = vi.fn(() => fakeProc() as any);
    const sup = new LLMSupervisor({
      getProvider: () => 'lm-studio',
      spawn,
      findLmsBinary: () => '/fake/lms',
      findOllamaBinary: () => '/fake/ollama',
      lmStudioProbe: async () => ({ ok: true }),
      ollamaProbe: async () => ({ ok: false }),
    });
    await sup.ensureReady();
    expect(spawn).not.toHaveBeenCalled();
    await sup.stop();
  });

  it('lm-studio mode spawns when nothing is on the port', async () => {
    let probeCalls = 0;
    const probe = async (): Promise<{ ok: boolean }> => {
      probeCalls += 1;
      // First call (pre-flight): not ok. After spawn: ok on poll.
      return { ok: probeCalls >= 2 };
    };
    const spawn = vi.fn(() => fakeProc() as any);
    const sup = new LLMSupervisor({
      getProvider: () => 'lm-studio',
      spawn,
      findLmsBinary: () => '/fake/lms',
      findOllamaBinary: () => '/fake/ollama',
      lmStudioProbe: probe,
      ollamaProbe: async () => ({ ok: false }),
      idleShutdownMs: 0,
    });
    await sup.ensureReady();
    expect(spawn).toHaveBeenCalledTimes(1);
    const [cmd, args] = spawn.mock.calls[0];
    expect(cmd).toBe('/fake/lms');
    expect(args).toEqual(['server', 'start', '--port', '1234']);
    await sup.stop();
  });

  it('ollama mode spawns `ollama serve` with OLLAMA_HOST env', async () => {
    let probeCalls = 0;
    const probe = async (): Promise<{ ok: boolean }> => {
      probeCalls += 1;
      return { ok: probeCalls >= 2 };
    };
    const spawn = vi.fn(() => fakeProc() as any);
    const sup = new LLMSupervisor({
      getProvider: () => 'ollama',
      spawn,
      findLmsBinary: () => '/fake/lms',
      findOllamaBinary: () => '/fake/ollama',
      lmStudioProbe: async () => ({ ok: false }),
      ollamaProbe: probe,
      idleShutdownMs: 0,
    });
    await sup.ensureReady();
    expect(spawn).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = spawn.mock.calls[0];
    expect(cmd).toBe('/fake/ollama');
    expect(args).toEqual(['serve']);
    expect(opts.env.OLLAMA_HOST).toBe('127.0.0.1:11434');
    await sup.stop();
  });

  it('switching providers routes ensureReady to the new one', async () => {
    let probeCalls = { lms: 0, ollama: 0 };
    const lmsProbe = async (): Promise<{ ok: boolean }> => {
      probeCalls.lms += 1;
      return { ok: probeCalls.lms >= 2 };
    };
    const ollamaProbe = async (): Promise<{ ok: boolean }> => {
      probeCalls.ollama += 1;
      return { ok: probeCalls.ollama >= 2 };
    };
    let provider: 'lm-studio' | 'ollama' = 'lm-studio';
    const spawn = vi.fn(() => fakeProc() as any);
    const sup = new LLMSupervisor({
      getProvider: () => provider,
      spawn,
      findLmsBinary: () => '/fake/lms',
      findOllamaBinary: () => '/fake/ollama',
      lmStudioProbe: lmsProbe,
      ollamaProbe,
      idleShutdownMs: 0,
    });
    await sup.ensureReady();
    expect(spawn.mock.calls[0][0]).toBe('/fake/lms');
    provider = 'ollama';
    probeCalls = { lms: 0, ollama: 0 };
    await sup.ensureReady();
    expect(spawn.mock.calls[1][0]).toBe('/fake/ollama');
    await sup.stop();
  });
});
