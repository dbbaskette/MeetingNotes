import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { SpeechClient, Transcript, Diarization, SPEAKER_REVISION } from './client.js';
import { installSpeakerModels, modelsReady } from './models.js';
import type { NativeSpeechStatus } from '../../shared/native-speech.js';

export function supportsNativeSpeech(platform = process.platform, arch = process.arch, release = os.release()): boolean {
  // macOS 26 uses Darwin 25. Apple Speech assets also require Apple silicon.
  return platform === 'darwin' && arch === 'arm64' && Number(release.split('.')[0]) >= 25;
}
export function appleLocale(language: string): string { return language === 'en' ? 'en-US' : language; }
const Health = z.object({ available: z.boolean(), installed: z.boolean() });

/** The stable app's only native-engine owner. Provisioning is explicit;
 * inference never downloads models, starts legacy servers, or reads HF tokens. */
export class NativeSpeechService {
  private readonly client: SpeechClient;
  private provisioning?: AbortController;
  private state: NativeSpeechStatus;
  private setupError: string | null = null;
  constructor(executable: string, private readonly modelFolder: string) {
    this.client = new SpeechClient(executable);
    this.state = { supported: supportsNativeSpeech() && fs.existsSync(executable), appleReady: false,
      speakerReady: modelsReady(modelFolder), busy: false, phase: 'Not checked', progress: 0, error: null };
  }
  snapshot(): NativeSpeechStatus { return { ...this.state }; }
  async status(language: string): Promise<NativeSpeechStatus> {
    if (this.state.supported && !this.state.busy) {
      try {
        const health = Health.parse((await this.client.request('health', { locale: appleLocale(language) })).result);
        this.state.appleReady = health.available && health.installed;
        this.state.error = health.available ? this.setupError : 'Apple transcription is unavailable for this language on this Mac.';
        this.state.speakerReady = modelsReady(this.modelFolder);
      } catch (e) { this.state.appleReady = false; this.state.error = String(e); }
    }
    return this.snapshot();
  }
  async prepare(language: string): Promise<NativeSpeechStatus> {
    if (!this.state.supported) throw new Error('Native speech requires Apple silicon, macOS 26 or newer, and the bundled speech helper.');
    if (this.provisioning) throw new Error('Speech setup is already running.');
    const controller = new AbortController(); this.provisioning = controller;
    this.setupError = null;
    this.state = { ...this.state, appleReady: false, busy: true, error: null, phase: 'Preparing Apple language assets', progress: 0 };
    try {
      await this.client.request('provision-apple', { locale: appleLocale(language) },
        { signal: controller.signal, progress: fraction => { this.state.progress = fraction; } });
      this.state.appleReady = true;
      this.state.phase = 'Downloading and verifying speaker models'; this.state.progress = 0;
      await installSpeakerModels(this.modelFolder, controller.signal, fraction => { this.state.progress = fraction; });
      this.state.speakerReady = true; this.state.phase = 'Ready';
    } catch (e) { this.setupError = this.state.error = controller.signal.aborted ? 'Setup cancelled. You can retry at any time.' : String(e); }
    finally { this.state.busy = false; this.provisioning = undefined; }
    return this.snapshot();
  }
  cancelSetup(): void { this.provisioning?.abort(); }
  close(): void { this.cancelSetup(); this.client.cancel(); }
  async transcribe(audioPath: string, language: string) {
    this.requireSupported();
    const value = Transcript.parse((await this.client.request('transcribe', { audioPath, locale: appleLocale(language) })).result);
    if (value.segments.some(s => s.end < s.start || s.end > value.durationS + 0.5)) throw new Error('Apple returned invalid transcript timestamps.');
    return value;
  }
  async diarize(audioPath: string) {
    this.requireSupported();
    if (!modelsReady(this.modelFolder)) throw new Error('Prepare native speech in Settings → Processing before processing this meeting.');
    const value = Diarization.parse((await this.client.request('diarize', { audioPath, modelFolder: this.modelFolder, modelRevision: SPEAKER_REVISION })).result);
    if (value.modelRevision !== SPEAKER_REVISION || value.embeddingSpace !== `speakerkit:1.1.1:${SPEAKER_REVISION}:raw-preplda:trainableOnly:16khz`
      || value.segments.some(s => s.end < s.start)) throw new Error('Speaker engine returned incompatible output.');
    return value;
  }
  private requireSupported(): void {
    if (!this.state.supported) throw new Error('Native speech is unavailable on this Mac. MeetingNotes requires Apple silicon and macOS 26 or newer.');
    if (this.state.busy) throw new Error('Wait for native speech setup to finish, then retry processing.');
  }
}
export function nativeModelFolder(home = os.homedir()): string {
  return path.join(home, 'Library', 'Application Support', 'MeetingNotes', 'speech-models', SPEAKER_REVISION);
}
