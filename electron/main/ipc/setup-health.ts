import fs from 'node:fs';
import { getMicAccessStatus } from '../permissions/audio.js';
import { effectiveLlmUrl } from '../../shared/inference-endpoints.js';
import type { IpcServices } from './handlers.js';
import { calendarFromServices, type CalendarService, type CalendarState } from '../calendar/service.js';

export interface SetupHealthRow { label: string; state: 'ready' | 'check' | 'blocked' | 'optional'; detail: string; section: string }

/** The Calendar row (#253). Off by default; reading it never prompts and,
 *  while the setting is off, spawns nothing. */
export function calendarRow(state: CalendarState): SetupHealthRow {
  const row = (rowState: SetupHealthRow['state'], detail: string): SetupHealthRow => ({ label: 'Calendar', state: rowState, detail, section: 'Recording' });
  switch (state) {
    case 'off': return row('optional', 'Optional and off. Turn on calendar-aware recording in Recording to title recordings from your calendar.');
    case 'fullAccess': return row('ready', 'Access granted. A recording that starts during a calendar event is titled from it.');
    case 'notDetermined': return row('check', 'Calendar access has not been asked yet. Turn calendar-aware recording off and on in Recording to ask.');
    case 'unavailable': return row('check', 'Calendar access could not be checked. Recording works as usual.');
    default: return row('check', 'Calendar access is not allowed, so recordings keep their usual title. Allow MeetingNotes in System Settings › Privacy & Security › Calendars.');
  }
}

export async function setupHealth(s: IpcServices, calendar: CalendarService = calendarFromServices(s)): Promise<SetupHealthRow[]> {
  const settings = s.settings.getAll();
  const rows: SetupHealthRow[] = [];
  const mic = getMicAccessStatus();
  rows.push({ label: 'Microphone', state: mic === 'granted' ? 'ready' : mic === 'denied' ? 'blocked' : 'check', detail: mic === 'granted' ? 'Permission granted' : 'Review microphone permission before capturing your voice', section: 'Recording' });
  rows.push({ label: 'Capture helper', state: fs.existsSync(s.helperPath) ? 'ready' : 'blocked', detail: fs.existsSync(s.helperPath) ? 'Installed; source/audio permission is verified by an explicit test' : 'Bundled recorder is missing; reinstall the app', section: 'Recording' });
  rows.push(calendarRow(await calendar.status()));
  let storage = true, freeBytes: number | null = null;
  try { fs.accessSync(s.libraryRoot, fs.constants.W_OK); const stat = fs.statfsSync(s.libraryRoot); freeBytes = stat.bavail * stat.bsize; } catch { storage = false; }
  rows.push({ label: 'Storage', state: !storage ? 'blocked' : freeBytes !== null && freeBytes < 1024 ** 3 ? 'check' : 'ready', detail: storage ? `Library is writable · ${freeBytes === null ? 'free space unavailable' : `${(freeBytes / 1024 ** 3).toFixed(1)} GB free`}. Keep space for audio and models.` : 'Library is not writable; correct its path or permissions', section: 'Storage' });
  const native = s.nativeSpeech?.snapshot();
  const whisper = settings.transcriptionEngine === 'whisperkit';
  rows.push({ label: 'Transcription', state: native?.supported && (whisper ? native.whisperReady : native.appleReady) ? 'ready' : 'check',
    detail: whisper ? 'WhisperKit uses a downloaded, verified model on this Mac. Download or check it in Processing.'
      : 'Apple transcription uses local language assets. Prepare or check them in Processing.', section: 'Processing' });
  rows.push({ label: 'Speakers', state: native?.supported && native.speakerReady ? 'ready' : 'check',
    detail: 'SpeakerKit uses verified local models. Prepare them in Processing; no account or token is required.', section: 'Processing' });
  rows.push({ label: 'Summary', state: 'check', detail: `${settings.summaryProvider} · ${effectiveLlmUrl(settings.summaryProvider, settings.lmStudioUrl)} · ${settings.llmModel || 'Choose a model'}. Managed services can be idle; use Test in Advanced to check connectivity.`, section: 'Advanced' });
  rows.push({ label: 'Exporters', state: 'optional', detail: 'Optional. Google, Obsidian and webhook setup do not block recording or processing.', section: 'Integrations' });
  return rows;
}
