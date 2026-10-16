import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { SettingsRepo } from '../storage/settings-repo.js';
import { atomicJson } from '../speakers/voice-profiles.js';
import type { SpeechSelection } from '../../shared/native-speech.js';
const Selection = z.object({ provider: z.literal('native'), language: z.string() });
/** Persist the native locale before either parallel worker starts. Recovery
 * reuses it; explicit reprocessing clears it along with the old raw artifacts. */
export function selectSpeech(folder: string, settings: SettingsRepo): SpeechSelection {
  const file = path.join(folder, 'processing-speech.json');
  if (fs.existsSync(file)) {
    const parsed = Selection.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')));
    if (parsed.success) return parsed.data;
    // Old queued jobs may pin a removed engine. Restart this speech phase
    // natively, without deleting settings or touching completed meetings.
  }
  const selected: SpeechSelection = { provider: 'native', language: settings.get('sttLanguage') };
  atomicJson(file, selected);
  return selected;
}
