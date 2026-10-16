import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { SettingsRepo } from '../storage/settings-repo.js';
import { atomicJson } from '../speakers/voice-profiles.js';
import type { SpeechSelection } from '../../shared/native-speech.js';
const Selection = z.object({ provider: z.enum(['native', 'legacy']), language: z.string(), model: z.string() });
/** Persist the engine choice before either parallel worker starts. Recovery
 * reuses it; explicit reprocessing clears it along with the old raw artifacts. */
export function selectSpeech(folder: string, settings: SettingsRepo): SpeechSelection {
  const file = path.join(folder, 'processing-speech.json');
  if (fs.existsSync(file)) return Selection.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
  const selected: SpeechSelection = { provider: settings.get('speechProvider'), language: settings.get('sttLanguage'), model: settings.get('sttModel') };
  atomicJson(file, selected);
  return selected;
}
