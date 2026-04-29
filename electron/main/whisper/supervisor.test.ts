// electron/main/whisper/supervisor.test.ts
//
// Tests the whisper-specific factory. Lifecycle behavior is covered
// by lib/managed-service.test.ts; here we verify the bits that live
// in supervisor.ts: model-path resolution, model-preference fallback,
// and that --model/--host/--port make it onto the spawn argv.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWhisperSupervisor, resolveModelPath } from './supervisor.js';

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
  ee.pid = 12346;
  return ee;
}

describe('createWhisperSupervisor', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-test-'));
  });

  it('adopts a healthy whisper-server already running on the port', async () => {
    const spawn = vi.fn(() => fakeProc() as any);
    const sup = createWhisperSupervisor({
      getModelId: () => 'medium.en',
      spawn,
      healthProbe: async () => ({ ok: true }),
      findBinary: () => '/usr/local/bin/whisper-server',
      resolveModel: () => '/fake/model.bin',
    });
    await sup.ensureReady();
    expect(spawn).not.toHaveBeenCalled();
    expect(sup.isRunning()).toBe(true);
    await sup.stop();
  });

  it('spawns whisper-server with --model/--host/--port when nothing is on the port', async () => {
    let probeCalls = 0;
    const probe = async (): Promise<{ ok: boolean }> => {
      probeCalls += 1;
      return { ok: probeCalls >= 2 };
    };
    const spawn = vi.fn(() => fakeProc() as any);
    const sup = createWhisperSupervisor({
      getModelId: () => 'medium.en',
      spawn,
      healthProbe: probe,
      findBinary: () => '/fake/whisper-server',
      resolveModel: (id) => `/models/ggml-${id}.bin`,
      startupPollIntervalMs: 5,
      idleShutdownMs: 0,
    });
    await sup.ensureReady();
    expect(spawn).toHaveBeenCalledTimes(1);
    const [cmd, args] = spawn.mock.calls[0];
    expect(cmd).toBe('/fake/whisper-server');
    expect(args).toEqual([
      '--model', '/models/ggml-medium.en.bin',
      '--host', '127.0.0.1',
      '--port', '8080',
    ]);
    await sup.stop();
  });

  it('reads the current sttModel each time resolveLaunch fires', async () => {
    let modelId = 'small.en';
    let probeCalls = 0;
    const probe = async (): Promise<{ ok: boolean }> => {
      probeCalls += 1;
      return { ok: probeCalls >= 2 };
    };
    const spawn = vi.fn(() => fakeProc() as any);
    const sup = createWhisperSupervisor({
      getModelId: () => modelId,
      spawn,
      healthProbe: probe,
      findBinary: () => '/fake/whisper-server',
      resolveModel: (id) => `/models/ggml-${id}.bin`,
      startupPollIntervalMs: 5,
      idleShutdownMs: 0,
    });
    await sup.ensureReady();
    expect(spawn.mock.calls[0][1]).toContain('/models/ggml-small.en.bin');
    await sup.stop();

    // User changes model in settings; next ensureReady picks it up.
    modelId = 'large-v3';
    probeCalls = 0;
    await sup.ensureReady();
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(spawn.mock.calls[1][1]).toContain('/models/ggml-large-v3.bin');
    await sup.stop();
  });
});

describe('resolveModelPath', () => {
  let tmpDir: string;
  let modelsDir: string;
  let originalHome: string | undefined;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-models-test-'));
    modelsDir = path.join(tmpDir, 'Library', 'Application Support', 'MeetingNotes', 'whisper-models');
    fs.mkdirSync(modelsDir, { recursive: true });
    originalHome = process.env.HOME;
    process.env.HOME = tmpDir;
  });
  afterEach(() => {
    if (originalHome) process.env.HOME = originalHome;
  });

  it('resolves an explicit modelId to ggml-<id>.bin', () => {
    fs.writeFileSync(path.join(modelsDir, 'ggml-medium.en.bin'), '');
    expect(resolveModelPath('medium.en')).toBe(path.join(modelsDir, 'ggml-medium.en.bin'));
  });

  it('falls back to preference order when explicit model is missing', () => {
    fs.writeFileSync(path.join(modelsDir, 'ggml-small.en.bin'), '');
    // Asks for medium.en (not installed); should fall back to small.en
    // which is next in the MODEL_PREFERENCE list after medium / medium.en.
    expect(resolveModelPath('medium.en')).toBe(path.join(modelsDir, 'ggml-small.en.bin'));
  });

  it('treats whisper-1 placeholder as "no preference" and auto-picks', () => {
    fs.writeFileSync(path.join(modelsDir, 'ggml-large-v3-turbo.bin'), '');
    expect(resolveModelPath('whisper-1')).toBe(path.join(modelsDir, 'ggml-large-v3-turbo.bin'));
  });

  it('throws a helpful error when no model is installed', () => {
    expect(() => resolveModelPath('medium.en')).toThrow(/No whisper model installed/);
  });
});
