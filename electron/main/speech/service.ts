import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { SpeechClient, Transcript, Diarization, SPEAKER_REVISION } from './client.js';
import { installSpeakerModels, modelsReady } from './models.js';
import { installWhisperModels, whisperModelFolder, whisperModelsReady, WHISPER_DOWNLOAD_BYTES } from './whisper-models.js';
import type { NativeSpeechStatus, TranscriptionEngine } from '../../shared/native-speech.js';

export function supportsNativeSpeech(platform = process.platform, arch = process.arch, release = os.release()): boolean {
  // macOS 26 uses Darwin 25. Apple Speech assets also require Apple silicon.
  return platform === 'darwin' && arch === 'arm64' && Number(release.split('.')[0]) >= 25;
}
export function appleLocale(language: string): string { return language === 'en' ? 'en-US' : language; }
const Health = z.object({ available: z.boolean(), installed: z.boolean() });

/** How long a "ready" health answer is reused. Each status() used to spawn
 *  the Swift helper, and Settings/onboarding call it repeatedly (#301). */
const STATUS_TTL_MS = 30_000;

/** A long meeting on a slow Mac can take far longer with WhisperKit than with Apple speech. */
const WHISPER_TIMEOUT_MS = 3 * 60 * 60_000;

/** The stable app's only native-engine owner. Provisioning is explicit;
 * inference never downloads models, starts legacy servers, or reads HF tokens. */
export class NativeSpeechService {
  private readonly client: SpeechClient;
  private provisioning?: AbortController;
  private state: NativeSpeechStatus;
  private setupError: string | null = null;
  private statusCache?: { locale: string; checkedAt: number };
  constructor(executable: string, private readonly modelFolder: string, private readonly whisperFolder = whisperModelFolder()) {
    this.client = new SpeechClient(executable);
    this.state = { supported: supportsNativeSpeech() && fs.existsSync(executable), appleReady: false,
      speakerReady: modelsReady(modelFolder), whisperReady: whisperModelsReady(this.whisperFolder), engine: 'apple',
      transcriptionReady: false, busy: false, phase: 'Not checked', progress: 0, error: null };
  }
  snapshot(): NativeSpeechStatus {
    return { ...this.state, transcriptionReady: this.state.engine === 'whisperkit' ? this.state.whisperReady : this.state.appleReady };
  }
  async status(language: string, engine: TranscriptionEngine = 'apple'): Promise<NativeSpeechStatus> {
    const locale = appleLocale(language);
    if (!this.state.busy) this.state.engine = engine;
    if (this.state.supported && !this.state.busy && engine === 'whisperkit') {
      // Apple assets are not used by this engine, so do not report a language
      // Apple lacks as an error. The model check is a few file stats.
      this.state.whisperReady = whisperModelsReady(this.whisperFolder);
      this.state.speakerReady = modelsReady(this.modelFolder);
      this.state.error = this.setupError;
    } else if (this.state.supported && !this.state.busy) {
      const now = Date.now();
      if (this.statusCache && this.statusCache.locale === locale && now - this.statusCache.checkedAt < STATUS_TTL_MS) {
        this.state.speakerReady = modelsReady(this.modelFolder);
        this.state.whisperReady = whisperModelsReady(this.whisperFolder);
        return this.snapshot();
      }
      try {
        const health = Health.parse((await this.client.request('health', { locale })).result);
        this.state.appleReady = health.available && health.installed;
        this.state.error = health.available ? this.setupError : 'Apple transcription is unavailable for this language on this Mac.';
        this.state.speakerReady = modelsReady(this.modelFolder);
        this.state.whisperReady = whisperModelsReady(this.whisperFolder);
        // Cache only a ready answer. "Not installed yet" must be re-checked on
        // the next call, or Settings/onboarding would lag behind a download.
        this.statusCache = this.state.appleReady ? { locale, checkedAt: Date.now() } : undefined;
      } catch (e) { this.state.appleReady = false; this.state.error = String(e); this.statusCache = undefined; }
    }
    return this.snapshot();
  }
  async prepare(language: string, engine: TranscriptionEngine = 'apple'): Promise<NativeSpeechStatus> {
    if (!this.state.supported) throw new Error('Native speech requires Apple silicon, macOS 26 or newer, and the bundled speech helper.');
    if (this.provisioning) throw new Error('Speech setup is already running.');
    this.statusCache = undefined;
    const controller = new AbortController(); this.provisioning = controller;
    this.setupError = null;
    const report = (fraction: number): void => { this.state.progress = fraction; };
    this.state = { ...this.state, engine, busy: true, error: null, progress: 0,
      ...(engine === 'whisperkit' ? { whisperReady: false, phase: 'Downloading and verifying speaker models' }
        : { appleReady: false, phase: 'Preparing Apple language assets' }) };
    try {
      if (engine === 'apple') {
        await this.client.request('provision-apple', { locale: appleLocale(language) }, { signal: controller.signal, progress: report });
        this.state.appleReady = true;
        this.state.phase = 'Downloading and verifying speaker models'; this.state.progress = 0;
      }
      await installSpeakerModels(this.modelFolder, controller.signal, report);
      this.state.speakerReady = true;
      if (engine === 'whisperkit') {
        // Apple's assets are not needed for this engine and its language may
        // be one Apple does not offer, so they are left as they are.
        this.state.phase = `Downloading and verifying the WhisperKit model (${Math.round(WHISPER_DOWNLOAD_BYTES / 1e6)} MB)`; this.state.progress = 0;
        await installWhisperModels(this.whisperFolder, controller.signal, report);
        // First load compiles the model for this Mac's chip. Do it here, not
        // in the middle of the first meeting.
        this.state.phase = 'Optimizing the model for this Mac. The first time can take several minutes'; this.state.progress = 0;
        await this.client.request('prepare-whisperkit', { modelFolder: this.whisperFolder }, { signal: controller.signal });
        this.state.whisperReady = true;
      }
      this.state.phase = 'Ready';
    } catch (e) { this.setupError = this.state.error = controller.signal.aborted ? 'Setup cancelled. You can retry at any time.' : String(e); }
    finally { this.state.busy = false; this.provisioning = undefined; }
    return this.snapshot();
  }
  cancelSetup(): void { this.provisioning?.abort(); }
  close(): void { this.cancelSetup(); this.client.cancel(); }
  async transcribe(audioPath: string, language: string, options: { signal?: AbortSignal; progress?: (fraction: number) => void;
    engine?: TranscriptionEngine; vocabulary?: string[] } = {}) {
    this.requireSupported();
    const engine = options.engine ?? 'apple';
    const { signal, progress } = options;
    const contextualStrings = options.vocabulary?.length ? options.vocabulary : undefined;
    // Never download here: a missing model is a setup step the user chose not to take yet.
    if (engine === 'whisperkit' && !whisperModelsReady(this.whisperFolder))
      throw new Error('Download the WhisperKit model in Settings → Processing before processing this meeting, or switch the transcription engine back to Apple Speech.');
    const response = engine === 'whisperkit'
      ? await this.client.request('transcribe', { audioPath, locale: appleLocale(language), engine, modelFolder: this.whisperFolder, contextualStrings },
          { signal, progress, timeoutMs: WHISPER_TIMEOUT_MS })
      : await this.client.request('transcribe', { audioPath, locale: appleLocale(language), contextualStrings }, { signal, progress });
    const value = Transcript.parse(response.result);
    if (value.provider !== engine) throw new Error('The speech helper answered with a different transcription engine.');
    if (value.segments.some(s => s.end < s.start || s.end > value.durationS + 0.5)) throw new Error('The speech engine returned invalid transcript timestamps.');
    return value;
  }
  async diarize(audioPath: string, options: { signal?: AbortSignal } = {}) {
    this.requireSupported();
    if (!modelsReady(this.modelFolder)) throw new Error('Prepare native speech in Settings → Processing before processing this meeting.');
    const value = Diarization.parse((await this.client.request('diarize', { audioPath, modelFolder: this.modelFolder, modelRevision: SPEAKER_REVISION }, options)).result);
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
