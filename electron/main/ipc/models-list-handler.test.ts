import { expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ BrowserWindow: {}, dialog: {}, nativeTheme: {}, shell: {} }));
import { registerSettingsHandlers } from './settings-handlers.js';
import type { IpcServices } from './handlers.js';

function register(services: Record<string, unknown>) {
  const handlers = new Map<string, (...args: any[]) => any>();
  registerSettingsHandlers({ handle: (name: string, h: (...args: any[]) => any) => handlers.set(name, h) } as any,
    { logger: { info: () => {} }, ...services } as unknown as IpcServices);
  return () => handlers.get('models:list')!(null);
}

it('models:list wakes the managed LLM server before listing models', async () => {
  const order: string[] = [];
  const list = register({
    llmSupervisor: { ensureReady: vi.fn(), ensureServerUp: async () => { order.push('wake'); } },
    lmStudio: { listModels: async () => { order.push('list'); return ['qwen/qwen3.8-27b']; } },
  });
  expect(await list()).toEqual(['qwen/qwen3.8-27b']);
  expect(order).toEqual(['wake', 'list']);
});

it('models:list still tries the server when waking it fails', async () => {
  const list = register({
    llmSupervisor: { ensureReady: vi.fn(), ensureServerUp: async () => { throw new Error('lms not found'); } },
    lmStudio: { listModels: async () => ['a'] },
  });
  expect(await list()).toEqual(['a']);
});
