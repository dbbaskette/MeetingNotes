import fs from 'node:fs';
import { getMicAccessStatus } from '../permissions/audio.js';
import { effectiveLlmUrl } from '../../shared/inference-endpoints.js';
import type { IpcServices } from './handlers.js';

export function setupHealth(s: IpcServices): { label: string; state: 'ready' | 'check' | 'blocked' | 'optional'; detail: string; section: string }[] {
  const settings = s.settings.getAll();
  const rows: ReturnType<typeof setupHealth> = [];
  const mic = getMicAccessStatus();
  rows.push({ label: 'Microphone', state: mic === 'granted' ? 'ready' : mic === 'denied' ? 'blocked' : 'check', detail: mic === 'granted' ? 'Permission granted' : 'Review microphone permission before capturing your voice', section: 'Recording' });
  rows.push({ label: 'Capture helper', state: fs.existsSync(s.helperPath) ? 'ready' : 'blocked', detail: fs.existsSync(s.helperPath) ? 'Installed; source/audio permission is verified by an explicit test' : 'Bundled recorder is missing; reinstall the app', section: 'Recording' });
  let storage = true, freeBytes: number | null = null;
  try { fs.accessSync(s.libraryRoot, fs.constants.W_OK); const stat = fs.statfsSync(s.libraryRoot); freeBytes = stat.bavail * stat.bsize; } catch { storage = false; }
  rows.push({ label: 'Storage', state: !storage ? 'blocked' : freeBytes !== null && freeBytes < 1024 ** 3 ? 'check' : 'ready', detail: storage ? `Library is writable · ${freeBytes === null ? 'free space unavailable' : `${(freeBytes / 1024 ** 3).toFixed(1)} GB free`}. Keep space for audio and models.` : 'Library is not writable; correct its path or permissions', section: 'Storage' });
  const native = s.nativeSpeech?.snapshot();
  rows.push({ label: 'Transcription', state: native?.supported && native.appleReady ? 'ready' : 'check',
    detail: 'Apple transcription uses local language assets. Prepare or check them in Processing.', section: 'Processing' });
  rows.push({ label: 'Speakers', state: native?.supported && native.speakerReady ? 'ready' : 'check',
    detail: 'SpeakerKit uses verified local models. Prepare them in Processing; no account or token is required.', section: 'Processing' });
  rows.push({ label: 'Summary', state: 'check', detail: `${settings.summaryProvider} · ${effectiveLlmUrl(settings.summaryProvider, settings.lmStudioUrl)} · ${settings.llmModel || 'Choose a model'}. Managed services can be idle; use Test in Processing to check connectivity.`, section: 'Processing' });
  rows.push({ label: 'Exporters', state: 'optional', detail: 'Optional. Google, Obsidian and webhook setup do not block recording or processing.', section: 'Integrations' });
  return rows;
}
