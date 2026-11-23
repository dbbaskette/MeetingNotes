import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import path from 'node:path';
import ts from 'typescript';
import type { MeetingNotesApi } from './index.js';
import { IPC_CHANNELS as MAIN_CHANNELS } from '../main/ipc/contracts.js';

// Preload is CJS so we can't import it under vitest's ESM loader. Parse the
// IPC_CHANNELS entries out of the source file with a strict line regex —
// each entry is a single `key: 'value',` line. No code evaluation.
const preloadSrc = readFileSync(path.resolve(__dirname, 'index.ts'), 'utf8');
const block = preloadSrc.match(/const IPC_CHANNELS = \{([\s\S]*?)\} as const;/);
if (!block) throw new Error('could not locate IPC_CHANNELS in preload source');

const PRELOAD_CHANNELS: Record<string, string> = {};
const ENTRY = /^\s*([a-zA-Z][a-zA-Z0-9_]*)\s*:\s*'([^']+)'\s*,?\s*$/;
for (const line of block[1]!.split('\n')) {
  const m = line.match(ENTRY);
  if (m) PRELOAD_CHANNELS[m[1]!] = m[2]!;
}

describe('preload IPC_CHANNELS parity', () => {
  it('bridges page, hydration, and ID-snapshot requests with their inputs and results', async () => {
    // Execute the actual preload as CJS with only Electron's native boundary
    // substituted; no main-process module may be required by the preload.
    const invoke = vi.fn(async () => ({ result: 'from-main' }));
    let api: MeetingNotesApi | undefined;
    const compiled = ts.transpileModule(preloadSrc, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    runInNewContext(compiled, { exports: {}, require: (name: string) => {
      expect(name).toBe('electron');
      return { ipcRenderer: { invoke }, contextBridge: {
        exposeInMainWorld: (key: string, value: MeetingNotesApi) => { expect(key).toBe('api'); api = value; },
      } };
    } });
    const query = { filter: 'processing', sort: 'oldest', pageSize: 20, cursor: 'opaque' } as const;
    expect(await api!.meetings.listPage(query)).toEqual({ result: 'from-main' });
    expect(invoke).toHaveBeenLastCalledWith('meetings:list-page', query);
    expect(await api!.meetings.getMany(['b', 'a'])).toEqual({ result: 'from-main' });
    expect(invoke).toHaveBeenLastCalledWith('meetings:get-many', ['b', 'a']);
    expect(await api!.meetings.listIds('done')).toEqual({ result: 'from-main' });
    expect(invoke).toHaveBeenLastCalledWith('meetings:list-ids', 'done');
  });

  it('bridges the silence prompt: Continue, the pending state, and both push events', async () => {
    const invoke = vi.fn(async () => null);
    const listeners = new Map<string, (event: unknown, payload: unknown) => void>();
    const on = vi.fn((channel: string, listener: (event: unknown, payload: unknown) => void) => { listeners.set(channel, listener); });
    const off = vi.fn((channel: string, listener: unknown) => { if (listeners.get(channel) === listener) listeners.delete(channel); });
    let api: MeetingNotesApi | undefined;
    const compiled = ts.transpileModule(preloadSrc, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    runInNewContext(compiled, { exports: {}, require: () => ({ ipcRenderer: { invoke, on, off }, contextBridge: {
      exposeInMainWorld: (_key: string, value: MeetingNotesApi) => { api = value; },
    } }) });
    await api!.recording.continueSilence('a1b2c3d4');
    expect(invoke).toHaveBeenLastCalledWith('recording:continue-silence', 'a1b2c3d4');
    expect(await api!.recording.silenceState()).toBeNull();
    expect(invoke).toHaveBeenLastCalledWith('recording:silence-state');

    const prompt = { sessionId: 'a1b2c3d4', silentForMs: 120_000, autoStopAtMs: 1_800_000_060_000 };
    const cleared = { sessionId: 'a1b2c3d4', reason: 'continued' as const };
    const onPrompt = vi.fn(), onCleared = vi.fn();
    const offPrompt = api!.recording.onSilencePrompt(onPrompt), offCleared = api!.recording.onSilenceCleared(onCleared);
    listeners.get('recording:silence-prompt')!({}, prompt);
    listeners.get('recording:silence-cleared')!({}, cleared);
    // The callback gets the payload only, never the IPC event.
    expect(onPrompt.mock.calls).toEqual([[prompt]]);
    expect(onCleared.mock.calls).toEqual([[cleared]]);
    offPrompt(); offCleared();
    expect(listeners.size).toBe(0);
  });

  it('exposes the paginated library channels', () => {
    expect(PRELOAD_CHANNELS).toMatchObject({
      meetingsListPage: 'meetings:list-page',
      meetingsGetMany: 'meetings:get-many',
      meetingsListIds: 'meetings:list-ids',
    });
  });
  it('matches the main-process IPC_CHANNELS exactly', () => {
    expect(PRELOAD_CHANNELS).toEqual(MAIN_CHANNELS);
  });
});
