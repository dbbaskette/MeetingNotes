import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { SettingsRepo } from '../storage/settings-repo.js';
import { atomicJson } from '../speakers/voice-profiles.js';
import type { SpeechSelection } from '../../shared/native-speech.js';
import { WHISPER_MODEL } from './whisper-models.js';
// A run pinned before the engine choice existed (#306) has no `engine`: it was Apple.
const Selection = z.object({ provider: z.literal('native'), language: z.string(),
  engine: z.enum(['apple', 'whisperkit']).default('apple'), model: z.string().optional() });
/** Persist the native locale and engine before either parallel worker starts.
 * Recovery reuses them; explicit reprocessing clears the file along with the
 * old raw artifacts, so a reprocess picks up the current settings. */
export function selectSpeech(folder: string, settings: SettingsRepo): SpeechSelection {
  const file = path.join(folder, 'processing-speech.json');
  if (fs.existsSync(file)) {
    const parsed = Selection.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')));
    if (parsed.success) return parsed.data;
    // Old queued jobs may pin a removed engine. Restart this speech phase
    // natively, without deleting settings or touching completed meetings.
  }
  const engine = settings.get('transcriptionEngine');
  const selected: SpeechSelection = { provider: 'native', language: settings.get('sttLanguage'), engine,
    ...(engine === 'whisperkit' ? { model: WHISPER_MODEL } : {}) };
  atomicJson(file, selected);
  return selected;
}
