import { z } from 'zod';
import { DEFAULT_SETTINGS } from './settings-repo.js';
import { existingFolder } from '../lib/pasted-path.js';

const enums: Record<string, readonly [string, ...string[]]> = {
  theme: ['system', 'light', 'dark'], summaryProvider: ['external', 'lm-studio', 'ollama'],
  summaryDetail: ['concise', 'standard', 'detailed'], webhookTemplate: ['compact', 'full', 'telegram-markdown', 'slack-blocks'],
  webhookOwnerFilter: ['mine', 'all', 'none'],
};
export function validateSetting(key: string, value: unknown): unknown {
  if (!Object.hasOwn(DEFAULT_SETTINGS, key)) throw new Error('Unknown setting');
  if (['obsidian', 'googleRefreshTokenEnc', 'googleAccountEmail', 'modelHealthChecks', 'windowBounds', 'webhookLastResult'].includes(key))
    throw new Error('Use the dedicated controls for this setting');
  if (enums[key]) return z.enum(enums[key]!).parse(value);
  if (key === 'autoDetectMeetings') return z.object({ browserTabs: z.boolean(), nativeApps: z.boolean(), silenceMs: z.number().finite().min(0).max(600_000) }).strict().parse(value);
  if (key === 'recordingBitrateKbps') return z.union([z.literal(96), z.literal(128), z.literal(192)]).parse(value);
  if (key === 'libraryPath' || key === 'audioWatchPath') {
    const input = z.string().max(4096).parse(value);
    return key === 'audioWatchPath' && !input.trim() ? '' : existingFolder(input);
  }
  if (key === 'lmStudioUrl' || key === 'sttUrl' || key === 'webhookUrl') {
    const input = z.string().max(4096).parse(value).trim();
    if (key === 'webhookUrl' && !input) return '';
    let url: URL;
    try { url = new URL(input); } catch { throw new Error('Enter a complete http:// or https:// URL'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      throw new Error('Use an HTTP or HTTPS URL without embedded credentials');
    if (key === 'webhookUrl' && url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
      throw new Error('Webhook URLs must use HTTPS, except on localhost');
    return input;
  }
  const fallback = DEFAULT_SETTINGS[key as keyof typeof DEFAULT_SETTINGS];
  if (typeof fallback === 'boolean') return z.boolean().parse(value);
  if (fallback === null) return z.string().max(4096).nullable().parse(value);
  return z.string().max(4096).parse(value);
}
