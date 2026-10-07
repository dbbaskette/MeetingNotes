import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BrowserWindow } from 'electron';
import type { SettingsRepo } from '../storage/settings-repo.js';
import type { MeetingsRepo } from '../storage/meetings-repo.js';

/** Opt-in CI only: an explicit argument AND an owned temporary fixture marker
 * are required. Normal launches ignore the environment. Never use real data,
 * register a protocol handler, capture audio or contact model/export services. */
export function packageSmokeRoot(argv = process.argv, candidate = process.env.MN_PACKAGE_SMOKE_DIR): string | null {
  if (!argv.includes('--meetingnotes-package-smoke')) return null;
  if (!candidate) throw new Error('Package smoke requires an isolated fixture directory');
  const root = fs.realpathSync(candidate), parents = new Set([fs.realpathSync(os.tmpdir())]);
  if (process.platform === 'darwin') parents.add(fs.realpathSync('/tmp'));
  if (!parents.has(path.dirname(root)) || !path.basename(root).startsWith('meetingnotes-package-smoke-')
      || fs.readFileSync(path.join(root, 'fixture-marker'), 'utf8') !== 'synthetic-meetingnotes-package-smoke-v1') {
    throw new Error('Unsafe package smoke directory');
  }
  return root;
}

export function seedPackageSmoke(root: string, settings: SettingsRepo, meetings?: MeetingsRepo): void {
  settings.set('libraryPath', root);
  settings.set('onboardedAt', '2026-10-07T00:00:00Z');
  settings.set('autoProcessRecordings', false);
  settings.set('autoRecordZoom', false);
  settings.set('autoDetectMeetings', { browserTabs: false, nativeApps: false, silenceMs: 5000 });
  if (!meetings || meetings.findById('smoke-0000')) return;
  for (let i = 0; i < 600; i++) {
    const id = `smoke-${String(i).padStart(4, '0')}`;
    meetings.insert({ id, slug: id, title: `Synthetic package meeting ${i}`, startedAt: '2026-10-07T00:00:00Z',
      audioPath: path.join(root, 'recordings', `${id}.m4a`), durationS: 60, status: 'pending', pipelineStage: 'discovered' });
  }
}

export async function verifyPackageSmoke(root: string, win: BrowserWindow, packaged: boolean): Promise<void> {
  if (!packaged) throw new Error('This check must run the packaged app, not source Electron');
  let painted = false;
  for (let i = 0; i < 200; i++) {
    painted = await win.webContents.executeJavaScript('document.body.innerText.includes("Synthetic package meeting")');
    if (painted) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (!painted) throw new Error('Packaged Library did not render synthetic meetings');
  const state = await win.webContents.executeJavaScript(`(async () => {
    const page = await window.api.meetings.listPage({filter:'all',sort:'newest',pageSize:50});
    const active = await window.api.recording.active();
    const settings = await window.api.settings.getAll();
    return {rows:page.rows.length,hasNext:!!page.nextCursor,active:active.length,autoProcess:settings.autoProcessRecordings,
      title:document.title,text:document.body.innerText.slice(0,1200)};
  })()`);
  if (state.rows !== 50 || !state.hasNext || state.active !== 0 || state.autoProcess !== false) throw new Error('Packaged IPC smoke assertion failed');
  const png = (await win.webContents.capturePage()).toPNG();
  if (png.byteLength < 10000) throw new Error('Packaged render screenshot is unexpectedly empty');
  fs.writeFileSync(path.join(root, 'render.png'), png);
  fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify({ packaged, softwareRendering: process.argv.includes('--disable-gpu'), ...state }, null, 2));
}
