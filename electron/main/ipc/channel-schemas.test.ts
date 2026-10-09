import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { IpcMain } from 'electron';
import { IPC_ARG_SCHEMAS, checkIpcArgs, validateIpc } from './channel-schemas.js';
import { IPC_CHANNELS } from './contracts.js';

/** Every `.handle(IPC_CHANNELS.name, ...)` call in the main process. */
function registeredChannels(): string[] {
  const dir = __dirname;
  const files = [...fs.readdirSync(dir).map((f) => path.join(dir, f)), path.resolve(dir, '../index.ts')]
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
  const names = new Set<string>();
  for (const file of files) {
    for (const match of fs.readFileSync(file, 'utf8').matchAll(/\.handle\(\s*IPC_CHANNELS\.(\w+)/g)) names.add(match[1]!);
  }
  return [...names].map((name) => {
    const channel = (IPC_CHANNELS as Record<string, string>)[name];
    if (!channel) throw new Error(`handler registered for unknown channel key ${name}`);
    return channel;
  }).sort();
}

describe('IPC argument schemas', () => {
  it('cover exactly the channels that have handlers', () => {
    expect(Object.keys(IPC_ARG_SCHEMAS).sort()).toEqual(registeredChannels());
  });

  it.each([
    ['meetings:get', [42]],
    ['meetings:get', ['']],
    ['meetings:get', []],
    ['meetings:get', ['id', 'extra']],
    ['meetings:start', [{ id: 'x' }]],
    ['meetings:set-skip-speaker-id', ['id', 'yes']],
    ['weekly:get-structured', ['2026', 41]],
    ['weekly:get-narrative', [2026, 41, 'force']],
    ['export:run', [{ exporter: 'pdf' }]],
    ['export:run', [{ exporter: 'pdf', meetingId: 'm', itemIds: 'all' }]],
    ['dialog:save', [{ defaultPath: 7 }]],
    ['transcript:export', [{ content: 5 }]],
    ['transcript:export', [{ content: 'x', format: 'docx' }]],
    ['obsidian:enable', ['not-a-uuid']],
    ['app:get-version', ['unexpected']],
    ['settings:set', [null, 'value']],
    ['speakers:merge', ['only-one']],
  ])('rejects malformed arguments for %s: %j', (channel, args) => {
    expect(checkIpcArgs(channel, args)).toMatch(new RegExp(`^Invalid .* for ${channel}: `));
  });

  it.each([
    ['meetings:get', ['abc']],
    ['meetings:list-ids', ['all']],
    ['meetings:list-ids', ['all', null]],
    ['meetings:get-many', [['a', 'b']]],
    ['meetings:get-many', [['a'], { shell: true }]],
    ['logs:tail', []],
    ['logs:tail', [500]],
    ['weekly:get-narrative', [2026, 41]],
    ['weekly:get-narrative', [2026, 41, true]],
    ['search:query', ['pricing', 20, undefined, { clientId: 'c', requestId: 1 }]],
    ['search:query', ['pricing', 20, null]],
    ['export:run', [{ exporter: 'pdf', meetingId: 'm', itemIds: ['a'], outputPath: undefined }]],
    ['dialog:save', [undefined]],
    ['obsidian:retry', []],
    ['terminology:offers', []],
    ['terminology:save', [{ from: 'Salsa', to: 'SLSA' }]],
    ['recovery:list', []],
    ['app:get-version', []],
  ])('accepts the shapes the preload sends for %s: %j', (channel, args) => {
    expect(checkIpcArgs(channel, args)).toBeNull();
  });

  it('never echoes argument values in the error', () => {
    const problem = checkIpcArgs('meetings:save-summary', ['id', { secret: 'do-not-log-this' }])!;
    expect(problem).toContain('meetings:save-summary');
    expect(problem).not.toContain('do-not-log-this');
  });
});

describe('validateIpc', () => {
  function fakeIpc() {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const ipc = { handle: (channel: string, fn: (...args: unknown[]) => unknown) => { handlers.set(channel, fn); }, on: vi.fn() };
    return { ipc: validateIpc(ipc as unknown as IpcMain), handlers, raw: ipc };
  }

  it('runs the handler with the original arguments when they are valid', async () => {
    const { ipc, handlers } = fakeIpc();
    const handler = vi.fn(() => 'ok');
    ipc.handle('meetings:get', handler);
    const event = {};
    expect(await handlers.get('meetings:get')!(event, 'abc')).toBe('ok');
    expect(handler).toHaveBeenCalledWith(event, 'abc');
  });

  it('rejects malformed arguments before the handler runs', () => {
    const { ipc, handlers } = fakeIpc();
    const handler = vi.fn();
    ipc.handle('meetings:start', handler);
    expect(() => handlers.get('meetings:start')!({}, 12)).toThrow(/Invalid argument 0 for meetings:start/);
    expect(handler).not.toHaveBeenCalled();
  });

  it('refuses to register a channel that has no schema', () => {
    const { ipc } = fakeIpc();
    expect(() => ipc.handle('brand-new:channel', vi.fn())).toThrow(/No argument schema for IPC channel brand-new:channel/);
  });

  it('passes other ipcMain members through', () => {
    const { ipc, raw } = fakeIpc();
    ipc.on('x', () => {});
    expect(raw.on).toHaveBeenCalled();
  });
});
