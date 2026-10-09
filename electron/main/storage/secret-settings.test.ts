import { describe, it, expect } from 'vitest';
import { SecretSettings, isSealed, type SecretCipher } from './secret-settings.js';
import { DEFAULT_SETTINGS, type Settings } from './settings-repo.js';
import { SAVED_SECRET_MASK } from '../../shared/secrets.js';

function setup(available = true) {
  const data: Settings = { ...DEFAULT_SETTINGS };
  const store = {
    get: <K extends keyof Settings>(key: K) => data[key],
    set: <K extends keyof Settings>(key: K, value: Settings[K]) => { data[key] = value; },
  };
  const state = { available };
  // Reversible stand-in for the keychain: not the plaintext, and detectable.
  const cipher: SecretCipher = {
    isEncryptionAvailable: () => state.available,
    encryptString: (plain) => Buffer.from(`cipher(${plain})`),
    decryptString: (buf) => {
      const m = /^cipher\((.*)\)$/s.exec(buf.toString());
      if (!m) throw new Error('bad ciphertext');
      return m[1]!;
    },
  };
  return { data, state, secrets: new SecretSettings(store, cipher) };
}

describe('SecretSettings', () => {
  it('stores a secret encrypted and reads it back in main', () => {
    const { data, secrets } = setup();
    expect(secrets.write('webhookSecret', 'hunter2')).toBe(SAVED_SECRET_MASK);
    expect(isSealed(data.webhookSecret)).toBe(true);
    expect(data.webhookSecret).not.toContain('hunter2');
    expect(secrets.read('webhookSecret')).toBe('hunter2');
  });

  it('treats the mask as unchanged and an empty string as removal', () => {
    const { data, secrets } = setup();
    secrets.write('googleClientSecret', 'GOCSPX-abc');
    const sealed = data.googleClientSecret;
    expect(secrets.write('googleClientSecret', SAVED_SECRET_MASK)).toBe(SAVED_SECRET_MASK);
    expect(data.googleClientSecret).toBe(sealed);
    expect(secrets.write('googleClientSecret', '')).toBe('');
    expect(data.googleClientSecret).toBe('');
    expect(secrets.write('googleClientSecret', SAVED_SECRET_MASK)).toBe('');
  });

  it('rejects text typed onto the end of the mask', () => {
    const { secrets } = setup();
    secrets.write('webhookSecret', 'old');
    expect(() => secrets.write('webhookSecret', `${SAVED_SECRET_MASK}new`)).toThrow(/Replace the whole saved value/);
    expect(secrets.read('webhookSecret')).toBe('old');
  });

  it('refuses to store plaintext when encryption is unavailable', () => {
    const { data, secrets } = setup(false);
    expect(() => secrets.write('webhookSecret', 'hunter2')).toThrow(/Keychain encryption is unavailable/);
    expect(data.webhookSecret).toBe('');
  });

  it('migrates legacy plaintext once and keeps it readable', () => {
    const { data, secrets } = setup();
    data.webhookSecret = 'legacy-token';
    expect(secrets.read('webhookSecret')).toBe('legacy-token');
    expect(secrets.migrate()).toEqual(['webhookSecret']);
    expect(isSealed(data.webhookSecret)).toBe(true);
    expect(secrets.read('webhookSecret')).toBe('legacy-token');
    expect(secrets.migrate()).toEqual([]);
  });

  it('leaves legacy plaintext alone when it cannot encrypt', () => {
    const { data, secrets } = setup(false);
    data.webhookSecret = 'legacy-token';
    expect(secrets.migrate()).toEqual([]);
    expect(data.webhookSecret).toBe('legacy-token');
    expect(secrets.read('webhookSecret')).toBe('legacy-token');
  });

  it('reads an undecryptable value as empty instead of throwing', () => {
    const { data, state, secrets } = setup();
    data.webhookSecret = 'enc:v1:' + Buffer.from('garbage').toString('base64');
    expect(secrets.read('webhookSecret')).toBe('');
    secrets.write('webhookSecret', 'ok');
    state.available = false;
    expect(secrets.read('webhookSecret')).toBe('');
  });

  it('redacts every secret from the renderer snapshot', () => {
    const { data, secrets } = setup();
    secrets.write('webhookSecret', 'hunter2');
    data.googleRefreshTokenEnc = 'c2VjcmV0';
    const view = secrets.redact(data);
    expect(view.webhookSecret).toBe(SAVED_SECRET_MASK);
    expect(view.googleClientSecret).toBe('');
    expect(view.googleRefreshTokenEnc).toBeNull();
    expect(JSON.stringify(view)).not.toContain('hunter2');
    expect(JSON.stringify(view)).not.toContain('enc:v1:');
    // The stored snapshot is not mutated.
    expect(isSealed(data.webhookSecret)).toBe(true);
  });
});
