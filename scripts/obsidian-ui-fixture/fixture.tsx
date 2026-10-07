import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../electron/renderer/src/index.css';
import type { ObsidianStatus, ObsidianOptions } from '../../electron/shared/obsidian';
let status: ObsidianStatus = { config: null, running: false, lastSuccess: null, pending: 0, synced: 0, error: null, issues: [] };
let draft: ObsidianOptions;
const calls: string[] = [];
const obsidian = {
  status: async () => structuredClone(status),
  choose: async () => '/disposable/Test vault',
  preview: async (options: ObsidianOptions) => {
    if (Object.keys(options).some(k => !['vault', 'folder', 'transcript', 'actionItems'].includes(k))) throw Error('Unexpected settings keys');
    calls.push('preview'); draft = options;
    return { token: 'preview-token', meetings: 500, destination: `${options.vault}/${options.folder}` };
  },
  enable: async () => { calls.push('enable'); status = { ...status, config: { ...draft, destination: 'fixture', enabled: true }, synced: 500 }; },
  disable: async () => { calls.push('disable'); status.config!.enabled = false; },
  retry: async () => { calls.push('retry'); },
  open: async () => { calls.push('open'); },
  repair: async () => { calls.push('repair'); },
  compare: async (id: string) => ({ id, revision: 'fixture', current: 'External edit\n\n## Personal notes\nKeep me', proposed: 'Latest generated text\n\n## Personal notes\nKeep me', canReplace: true }),
  replace: async () => { calls.push('replace'); status.issues = []; },
  exportComparison: async () => { calls.push('export'); },
};
Object.assign(window, { api: { obsidian }, fixture: { calls, issues: () => { status.issues = Array.from({ length: 100 }, (_, i) => ({ id: String(i), title: `Meeting ${i}`, error: 'Generated section edited in Obsidian' })); } } });
const { ObsidianSettings } = await import('../../electron/renderer/src/components/ObsidianSettings');
createRoot(document.getElementById('root')!).render(<main style={{ maxWidth: 800, margin: '24px auto', padding: 20 }}><h1>Settings</h1><ObsidianSettings /><p id="following">Other settings remain easy to reach.</p></main>);
