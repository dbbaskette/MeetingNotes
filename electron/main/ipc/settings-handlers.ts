import type { IpcMain } from 'electron';
import { dialog, nativeTheme, shell } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import { IPC_CHANNELS } from './contracts.js';
import type { IpcServices } from './handlers.js';
import type { Settings } from '../storage/settings-repo.js';
import { DEFAULT_SETTINGS } from '../storage/settings-repo.js';
import { storageLocations } from '../lib/storage-paths.js';
import { validateSetting } from '../storage/settings-validation.js';
import { isSecretSettingKey } from '../../shared/secrets.js';
import { isSafeExternalUrl } from '../lib/navigation-guard.js';

export function registerSettingsHandlers(ipc: IpcMain, s: IpcServices): void {
  const native = () => { if (!s.nativeSpeech) throw new Error('Native speech helper is unavailable. Reinstall MeetingNotes.'); return s.nativeSpeech; };
  ipc.handle(IPC_CHANNELS.nativeSpeechStatus, () => native().status(s.settings.get('sttLanguage')));
  ipc.handle(IPC_CHANNELS.nativeSpeechPrepare, () => {
    if (s.pipeline.getStatus().currentId || s.pipeline.getStatus().queueLength) throw new Error('Wait for processing to finish before preparing speech assets.');
    return native().prepare(s.settings.get('sttLanguage'));
  });
  ipc.handle(IPC_CHANNELS.nativeSpeechCancel, () => native().cancelSetup());
  // Secrets never cross to the renderer: it sees a mask or an empty string.
  ipc.handle(IPC_CHANNELS.settingsGet, () => s.secrets.redact(s.settings.getAll()));
  ipc.handle(IPC_CHANNELS.settingsSet, (_e: unknown, key: unknown, value: unknown) => {
    if (typeof key !== 'string' || !(key in DEFAULT_SETTINGS)) throw new Error(`unknown setting: ${String(key)}`);
    value = validateSetting(key, value);
    if (key === 'sttLanguage') {
      const status = s.pipeline.getStatus();
      if (status.currentId || status.queueLength || s.nativeSpeech?.snapshot().busy) throw new Error('Wait for processing and speech setup to finish before changing the speech language.');
    }
    if (isSecretSettingKey(key)) return s.secrets.write(key, value as string);
    // Register first: a shortcut another app already holds must be refused
    // with a readable error, not saved and silently dead.
    if (key === 'recordShortcut') s.recordShortcut?.apply(value as string);
    s.settings.set(key as keyof Settings, value as Settings[keyof Settings]);
    if (key === 'showMenuBarIcon') s.menuBar?.setVisible(value as boolean);
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
    return value;
  });

  ipc.handle(IPC_CHANNELS.settingsChooseFolder, async () => {
    const result = await dialog.showOpenDialog({ title: 'Choose folder', properties: ['openDirectory'] });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });

  ipc.handle(IPC_CHANNELS.settingsRevealStorage, (_e: unknown, key: unknown) => {
    const rows = storageLocations({
      libraryRoot: s.libraryRoot,
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

  ipc.handle(IPC_CHANNELS.onboardingOpenExternal, async (_e, url: unknown) => {
    if (typeof url !== 'string' || !isSafeExternalUrl(url, { allowSystemSettings: true })) {
      throw new Error('invalid url');
    }
    await shell.openExternal(url);
  });
}
