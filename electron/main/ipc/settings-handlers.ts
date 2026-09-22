import type { IpcMain } from 'electron';
import { BrowserWindow, nativeTheme, shell } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IPC_CHANNELS } from './contracts.js';
import type { IpcServices } from './handlers.js';
import type { Settings } from '../storage/settings-repo.js';
import { DEFAULT_SETTINGS } from '../storage/settings-repo.js';
import { storageLocations } from '../lib/storage-paths.js';
import { downloadWhisperModel } from '../whisper/download-model.js';

export function registerSettingsHandlers(ipc: IpcMain, s: IpcServices): void {
  ipc.handle(IPC_CHANNELS.settingsGet, () => s.settings.getAll());
  ipc.handle(IPC_CHANNELS.settingsSet, (_e: unknown, key: unknown, value: unknown) => {
    if (typeof key !== 'string' || !(key in DEFAULT_SETTINGS)) throw new Error(`unknown setting: ${String(key)}`);
    s.settings.set(key as keyof Settings, value as Settings[keyof Settings]);
    if (key === 'theme') {
      nativeTheme.themeSource = value as 'system' | 'light' | 'dark';
    }
    // Toggle each meeting detector live when the user flips its switch —
    // no need to restart the app. autoDetectMeetings is the object form
    // post-#78 (browserTabs / nativeApps / silenceMs).
    if (key === 'autoDetectMeetings') {
      const cfg = s.settings.get('autoDetectMeetings');
      if (s.meetingDetector) {
        if (cfg.browserTabs) s.meetingDetector.start();
        else s.meetingDetector.stop();
      }
      if (s.nativeAppDetector) {
        if (cfg.nativeApps) s.nativeAppDetector.start();
        else s.nativeAppDetector.stop();
      }
    }
  });

  ipc.handle(IPC_CHANNELS.settingsRevealStorage, (_e: unknown, key: unknown) => {
    const rows = storageLocations({
      libraryRoot: s.settings.get('libraryPath'),
      home: os.homedir(),
    });
    const row = rows.find((r) => r.key === key);
    if (!row) throw new Error(`unknown storage location: ${String(key)}`);
    fs.mkdirSync(row.path, { recursive: true });
    shell.showItemInFolder(row.path);
  });

  ipc.handle(IPC_CHANNELS.modelsList, async () => {
    try { return await s.lmStudio.listModels(); }
    catch { return []; }
  });

  // Onboarding-wizard handlers (#43). Kept out of the main settings
  // block because they're only used during first-run setup.
  ipc.handle(IPC_CHANNELS.onboardingWhisperList, async () => {
    const dir = path.join(os.homedir(), 'Library', 'Application Support', 'MeetingNotes', 'whisper-models');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter((f) => f.startsWith('ggml-') && f.endsWith('.bin'))
      .map((f) => f.replace(/^ggml-/, '').replace(/\.bin$/, ''));
  });

  ipc.handle(IPC_CHANNELS.onboardingWhisperInstall, async (_e, model: unknown) => {
    if (typeof model !== 'string') throw new Error('invalid model id');
    // Native streaming download (no shell script). The old path shelled out to
    // scripts/whisper-server.sh, which isn't bundled into the packaged .app —
    // so onboarding's model download failed there with "No such file or
    // directory". downloadWhisperModel validates the id and pulls the ggml
    // file straight into the whisper-models directory. Progress fans out on
    // the onboarding:whisper-progress push channel (throttled to ~4/sec in
    // download-model.ts) so the wizard can render a real progress bar.
    await downloadWhisperModel(model, {
      onProgress: (received, total) => {
        BrowserWindow.getAllWindows().forEach((w) =>
          w.webContents.send(IPC_CHANNELS.onboardingWhisperProgress, { model, received, total }));
      },
    });
  });

  ipc.handle(IPC_CHANNELS.onboardingHfTokenSave, async (_e, token: unknown) => {
    if (typeof token !== 'string' || token.length < 8) throw new Error('invalid token');
    const dir = path.join(os.homedir(), '.cache', 'huggingface');
    fs.mkdirSync(dir, { recursive: true });
    const tokenPath = path.join(dir, 'token');
    fs.writeFileSync(tokenPath, token, { mode: 0o600 });
    // Set perms explicitly in case writeFileSync's mode arg is honored
    // only at file creation on some filesystems.
    try { fs.chmodSync(tokenPath, 0o600); } catch { /* best-effort */ }
  });

  ipc.handle(IPC_CHANNELS.onboardingHfTokenStatus, async () => {
    // Report whether a non-empty token file exists — so the wizard's HF step,
    // after the user navigates away and back, shows "already saved" rather than
    // a blank field that looks like the token vanished. We never read the
    // secret back into the renderer.
    const tokenPath = path.join(os.homedir(), '.cache', 'huggingface', 'token');
    let saved = false;
    try { saved = fs.existsSync(tokenPath) && fs.readFileSync(tokenPath, 'utf8').trim().length > 0; }
    catch { saved = false; }
    return { saved };
  });

  ipc.handle(IPC_CHANNELS.onboardingOpenExternal, async (_e, url: unknown) => {
    if (typeof url !== 'string' || !(url.startsWith('https://') || url.startsWith('x-apple.systempreferences:'))) {
      throw new Error('invalid url');
    }
    await shell.openExternal(url);
  });
}
