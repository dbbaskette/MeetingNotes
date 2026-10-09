// electron/main/storage/secret-settings.ts
//
// Encrypts secret settings with the OS keychain (Electron safeStorage) and
// keeps their values out of the renderer (#249). The Google refresh token
// already worked this way; this extends it to the webhook bearer token and
// the Google OAuth client secret.

import type { Settings } from './settings-repo.js';
import { SAVED_SECRET_MASK, SECRET_SETTING_KEYS, type SecretSettingKey } from '../../shared/secrets.js';

/** The subset of Electron's safeStorage used here; injected for tests. */
export interface SecretCipher {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(data: Buffer): string;
}

interface SettingsStore {
  get<K extends keyof Settings>(key: K): Settings[K];
  set<K extends keyof Settings>(key: K, value: Settings[K]): void;
}

const SEALED_PREFIX = 'enc:v1:';

export function isSealed(stored: string): boolean {
  return stored.startsWith(SEALED_PREFIX);
}

export class SecretSettings {
  constructor(private readonly settings: SettingsStore, private readonly cipher: SecretCipher) {}

  /** Plaintext for main-process use only. A value saved before encryption
   *  existed is returned as stored; an unreadable value reads as empty. */
  read(key: SecretSettingKey): string {
    const stored = this.settings.get(key);
    if (!stored || !isSealed(stored)) return stored ?? '';
    if (!this.cipher.isEncryptionAvailable()) return '';
    try { return this.cipher.decryptString(Buffer.from(stored.slice(SEALED_PREFIX.length), 'base64')); }
    catch { return ''; }
  }

  /** Stores a new value. Returns what the renderer should display. */
  write(key: SecretSettingKey, value: string): string {
    if (value === SAVED_SECRET_MASK) return this.display(key);
    if (value.includes(SAVED_SECRET_MASK)) throw new Error('Replace the whole saved value instead of adding to it');
    if (value === '') { this.settings.set(key, ''); return ''; }
    if (!this.cipher.isEncryptionAvailable()) throw new Error('Keychain encryption is unavailable, so this secret was not saved');
    this.settings.set(key, SEALED_PREFIX + this.cipher.encryptString(value).toString('base64'));
    return SAVED_SECRET_MASK;
  }

  /** Encrypts values saved as plaintext by earlier versions. Returns the
   *  keys that were converted. Leaves them untouched when encryption is
   *  unavailable so nothing is lost. */
  migrate(): SecretSettingKey[] {
    // Look for work before touching the cipher: asking the keychain can show
    // a macOS permission prompt, which must not block every launch.
    const pending = SECRET_SETTING_KEYS.filter((key) => {
      const stored = this.settings.get(key);
      return !!stored && !isSealed(stored);
    });
    if (pending.length === 0 || !this.cipher.isEncryptionAvailable()) return [];
    const migrated: SecretSettingKey[] = [];
    for (const key of pending) {
      const stored = this.settings.get(key);
      this.settings.set(key, SEALED_PREFIX + this.cipher.encryptString(stored).toString('base64'));
      migrated.push(key);
    }
    return migrated;
  }

  /** The settings snapshot that may cross to the renderer. */
  redact(all: Settings): Settings {
    const out: Settings = { ...all, googleRefreshTokenEnc: null };
    for (const key of SECRET_SETTING_KEYS) out[key] = all[key] ? SAVED_SECRET_MASK : '';
    return out;
  }

  private display(key: SecretSettingKey): string {
    return this.settings.get(key) ? SAVED_SECRET_MASK : '';
  }
}
