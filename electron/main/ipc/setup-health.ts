import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getMicAccessStatus } from '../permissions/audio.js';
import { findWhisperBinary, resolveModelPath } from '../whisper/supervisor.js';
import { resolveWhisperEndpoint, effectiveLlmUrl } from '../../shared/inference-endpoints.js';
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
  const endpoint = resolveWhisperEndpoint(settings.sttUrl);
  if (endpoint.kind === 'managed') {
    try {
      findWhisperBinary();
      rows.push({ label: 'Transcription', state: 'check', detail: `Managed local service may be idle. Model: ${resolveModelPath(settings.sttModel)}. Use Test in Advanced to check the endpoint.`, section: 'Processing' });
    } catch (error) { rows.push({ label: 'Transcription', state: 'blocked', detail: (error as Error).message, section: 'Processing' }); }
  } else rows.push({ label: 'Transcription', state: 'check', detail: `External endpoint ${settings.sttUrl}; configured model ${settings.sttModel}. Use its Test control in Advanced.`, section: 'Advanced' });
  rows.push({ label: 'Summary', state: 'check', detail: `${settings.summaryProvider} · ${effectiveLlmUrl(settings.summaryProvider, settings.lmStudioUrl)} · ${settings.llmModel || 'Choose a model'}. Managed services can be idle; use Test in Processing to check connectivity.`, section: 'Processing' });
  let tokenPresent = !!process.env.HF_TOKEN?.trim();
  try { tokenPresent ||= fs.statSync(path.join(os.homedir(), '.cache', 'huggingface', 'token')).size > 0; } catch { /* no credential values returned */ }
  rows.push({ label: 'Diarization', state: tokenPresent ? 'check' : 'blocked', detail: tokenPresent ? 'Credential configured; gated-model access and inference still need the explicit setup check. Service may be idle.' : 'Hugging Face credential missing. Run setup and accept the required model terms before speaker processing.', section: 'Processing' });
  rows.push({ label: 'Exporters', state: 'optional', detail: 'Optional. Google, Obsidian and webhook setup do not block recording or processing.', section: 'Integrations' });
  return rows;
}
