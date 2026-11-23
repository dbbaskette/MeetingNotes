import { it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BrowserWindow } from 'electron';
import { packageSmokeRoot, verifyPackageSmoke } from './package-smoke.js';

it('requires explicit intent and a marked disposable root; never uses normal user data', () => {
  expect(packageSmokeRoot([], '/user/library')).toBeNull();
  expect(() => packageSmokeRoot(['--meetingnotes-package-smoke'], '/user/library')).toThrow();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meetingnotes-package-smoke-'));
  try {
    expect(() => packageSmokeRoot(['--meetingnotes-package-smoke'], root)).toThrow();
    fs.writeFileSync(path.join(root, 'fixture-marker'), 'synthetic-meetingnotes-package-smoke-v1');
    expect(packageSmokeRoot(['--meetingnotes-package-smoke'], root)).toBe(fs.realpathSync(root));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

const snapshot = { rows: 50, hasNext: true, active: 0, openActions: 0, speakerReviews: 0, autoProcess: false,
  micStatus: 'granted', title: 'MeetingNotes', text: 'Synthetic package meeting 0' };
function fakeWindow(capturePage: () => Promise<{ toPNG(): Buffer }>): BrowserWindow {
  return { webContents: {
    executeJavaScript: async (code: string) => code.includes('innerText.includes') ? true : snapshot,
    capturePage,
  } } as unknown as BrowserWindow;
}
function smokeRoot(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'meetingnotes-package-smoke-')); }

it('waits out the GPU fallback: a capture rejected at first is retried until it succeeds', async () => {
  const root = smokeRoot();
  try {
    let calls = 0;
    const win = fakeWindow(async () => {
      if (++calls <= 2) throw new Error('UnknownVizError');
      return { toPNG: () => Buffer.alloc(20_000, 1) };
    });
    await verifyPackageSmoke(root, win, true);
    expect(calls).toBe(3);
    expect(fs.statSync(path.join(root, 'render.png')).size).toBe(20_000);
    expect(JSON.parse(fs.readFileSync(path.join(root, 'result.json'), 'utf8'))).toMatchObject({ packaged: true, view: 'library', rows: 50 });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it('still fails when the page can be captured but is blank', async () => {
  const root = smokeRoot();
  try {
    const win = fakeWindow(async () => ({ toPNG: () => Buffer.alloc(100) }));
    await expect(verifyPackageSmoke(root, win, true)).rejects.toThrow('unexpectedly empty');
    expect(fs.existsSync(path.join(root, 'result.json'))).toBe(false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it('refuses to run against source Electron', async () => {
  await expect(verifyPackageSmoke('/unused', fakeWindow(async () => ({ toPNG: () => Buffer.alloc(0) })), false)).rejects.toThrow('packaged app');
});
