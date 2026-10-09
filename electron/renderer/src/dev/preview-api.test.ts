import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import path from 'node:path';
import ts from 'typescript';
import { createPreviewApi, overrides } from './preview-api';

// Build the real preload API shape the same way contracts-parity.test.ts does:
// run the preload as CJS with only Electron's boundary substituted.
function realApiShape(): Record<string, unknown> {
  const src = readFileSync(path.resolve(__dirname, '../../../preload/index.ts'), 'utf8');
  const compiled = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  let api: Record<string, unknown> | undefined;
  runInNewContext(compiled, { exports: {}, require: () => ({
    ipcRenderer: { invoke: async () => undefined, on: () => undefined, removeListener: () => undefined },
    contextBridge: { exposeInMainWorld: (_key: string, value: Record<string, unknown>) => { api = value; } },
  }) });
  if (!api) throw new Error('preload did not expose an api');
  return api;
}

describe('browser preview api', () => {
  const real = realApiShape();
  const preview = createPreviewApi() as unknown as Record<string, Record<string, unknown>>;

  it('answers every method the preload exposes', () => {
    for (const [ns, value] of Object.entries(real)) {
      if (typeof value === 'function') {
        expect(typeof preview[ns], ns).toBe('function');
        continue;
      }
      for (const method of Object.keys(value as object)) {
        expect(typeof preview[ns]![method], `${ns}.${method}`).toBe('function');
      }
    }
  });

  it('only overrides names that exist in the preload', () => {
    for (const [ns, value] of Object.entries(overrides)) {
      expect(real, ns).toHaveProperty(ns);
      if (typeof value === 'function') continue;
      for (const method of Object.keys(value as object)) {
        expect(real[ns] as object, `${ns}.${method}`).toHaveProperty(method);
      }
    }
  });

  it('gives subscriptions an unsubscribe function and other calls a promise', async () => {
    const api = createPreviewApi() as unknown as Record<string, Record<string, (...a: unknown[]) => unknown> & ((...a: unknown[]) => unknown)>;
    expect(typeof api.pipeline!.onStatusChange!(() => {})).toBe('function');
    expect(typeof api.onMenuAction!(() => {})).toBe('function');
    await expect(api.meetings!.rename!('id', 'title')).resolves.toBeUndefined();
    await expect(api.notYetInvented!.anything!()).resolves.toBeUndefined();
  });

  it('lets tooling replace a method', async () => {
    const api = createPreviewApi();
    api.meetings.get = (async () => ({ id: 'x' })) as unknown as typeof api.meetings.get;
    await expect(api.meetings.get('x')).resolves.toEqual({ id: 'x' });
  });

  it('returns stable references and is not mistaken for a thenable', () => {
    const api = createPreviewApi();
    expect(api.meetings.list).toBe(api.meetings.list);
    expect(api.recording).toBe(api.recording);
    expect((api as unknown as { then?: unknown }).then).toBeUndefined();
  });
});
