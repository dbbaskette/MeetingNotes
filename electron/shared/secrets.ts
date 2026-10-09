// Secrets held in the settings table are encrypted at rest and never sent to
// the renderer (#249). The renderer sees this mask when a value is saved and
// an empty string when it is not; sending the mask back means "unchanged".

export const SAVED_SECRET_MASK = '••••••••';

export const SECRET_SETTING_KEYS = ['webhookSecret', 'googleClientSecret'] as const;
export type SecretSettingKey = typeof SECRET_SETTING_KEYS[number];

export function isSecretSettingKey(key: string): key is SecretSettingKey {
  return (SECRET_SETTING_KEYS as readonly string[]).includes(key);
}
