import { expect, it } from 'vitest';
import { validateSetting } from './settings-validation.js';
it('accepts only explicit booleans for voice auto-matching', () => {
  expect(validateSetting('autoMatchSpeakers', true)).toBe(true);
  expect(validateSetting('autoMatchSpeakers', false)).toBe(false);
  for (const value of ['true', 'false', 1, null, undefined]) expect(() => validateSetting('autoMatchSpeakers', value)).toThrow();
});
it('validates types, enum values and finite bounds at the IPC boundary', () => {
  expect(() => validateSetting('theme', 'purple')).toThrow();
  expect(() => validateSetting('recordingBitrateKbps', 0)).toThrow();
  expect(() => validateSetting('autoRecordZoom', 'yes')).toThrow();
  expect(() => validateSetting('autoDetectMeetings', {browserTabs: true, nativeApps: false, silenceMs: Infinity})).toThrow();
  expect(validateSetting('recordingBitrateKbps', 192)).toBe(192);
  expect(validateSetting('audioWatchPath', '')).toBe('');
});
it('validates the silence prompt settings: a boolean switch and whole seconds inside their ranges', () => {
  expect(validateSetting('autoStopOnSilence', false)).toBe(false);
  expect(validateSetting('autoStopOnSilence', true)).toBe(true);
  for (const value of ['false', 0, null, undefined]) expect(() => validateSetting('autoStopOnSilence', value)).toThrow();
  for (const value of [30, 120, 1800]) expect(validateSetting('silencePromptAfterS', value)).toBe(value);
  for (const value of [29, 1801, 0, -120, 90.5, '120', null, Infinity, NaN]) expect(() => validateSetting('silencePromptAfterS', value)).toThrow();
  for (const value of [10, 60, 600]) expect(validateSetting('silenceCountdownS', value)).toBe(value);
  for (const value of [9, 601, 0, -60, 30.5, '60', null, Infinity, NaN]) expect(() => validateSetting('silenceCountdownS', value)).toThrow();
});
it('accepts only the supported numeric context lengths', () => {
  for (const value of [0, 8192, 16384, 32768]) expect(validateSetting('llmContextLength', value)).toBe(value);
  for (const value of ['8192', -1, 8192.5, Infinity, NaN, 999999]) expect(() => validateSetting('llmContextLength', value)).toThrow();
});
it('rejects prototype keys, managed settings, malformed and unsafe endpoints', () => {
  for (const key of ['toString', '__proto__', 'obsidian', 'googleRefreshTokenEnc', 'speechProvider', 'sttUrl', 'sttModel']) expect(() => validateSetting(key, null)).toThrow();
  for (const value of ['local', 'file:///tmp/private', 'https://user:secret@example.org']) expect(() => validateSetting('lmStudioUrl', value)).toThrow();
  expect(() => validateSetting('webhookUrl', 'http://example.org')).toThrow('HTTPS');
  expect(validateSetting('webhookUrl', 'http://localhost:8080/hook')).toBe('http://localhost:8080/hook');
});
