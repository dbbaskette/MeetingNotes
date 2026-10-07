import { expect, it } from 'vitest';
import { validateSetting } from './settings-validation.js';
it('validates types, enum values and finite bounds at the IPC boundary', () => {
  expect(() => validateSetting('theme', 'purple')).toThrow();
  expect(() => validateSetting('recordingBitrateKbps', 0)).toThrow();
  expect(() => validateSetting('autoRecordZoom', 'yes')).toThrow();
  expect(() => validateSetting('autoDetectMeetings', {browserTabs: true, nativeApps: false, silenceMs: Infinity})).toThrow();
  expect(validateSetting('recordingBitrateKbps', 192)).toBe(192);
  expect(validateSetting('audioWatchPath', '')).toBe('');
});
it('rejects prototype keys, managed settings, malformed and unsafe endpoints', () => {
  for (const key of ['toString', '__proto__', 'obsidian', 'googleRefreshTokenEnc']) expect(() => validateSetting(key, null)).toThrow();
  for (const value of ['local', 'file:///tmp/private', 'https://user:secret@example.org']) expect(() => validateSetting('sttUrl', value)).toThrow();
  expect(() => validateSetting('webhookUrl', 'http://example.org')).toThrow('HTTPS');
  expect(validateSetting('webhookUrl', 'http://localhost:8080/hook')).toBe('http://localhost:8080/hook');
});
