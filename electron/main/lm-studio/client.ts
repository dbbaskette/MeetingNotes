import fs from 'node:fs/promises';
import path from 'node:path';

export class LMStudioError extends Error {
  constructor(message: string, public cause?: unknown) {
    super(message);
  }
}

export interface TranscribeInput {
  audioPath: string;
  model: string;
  language?: string;
  readFile?: (p: string) => Promise<Uint8Array>;
}

export interface TranscribeResult {
  text: string;
  segments: { start: number; end: number; text: string }[];
}

export class LMStudioClient {
  constructor(public readonly baseUrl: string) {}

  async listModels(): Promise<string[]> {
    let resp: Response;
    try {
      resp = await fetch(`${this.baseUrl}/v1/models`, {
        signal: AbortSignal.timeout(5000),
      });
    } catch (e) {
      throw new LMStudioError(`LM Studio unreachable at ${this.baseUrl}`, e);
    }
    if (!resp.ok) throw new LMStudioError(`LM Studio ${resp.status} on /v1/models`);
    const body = (await resp.json()) as { data?: { id: string }[] };
    return (body.data ?? []).map((m) => m.id);
  }

  async transcribe(input: TranscribeInput): Promise<TranscribeResult> {
    const read = input.readFile ?? ((p: string) => fs.readFile(p));
    const bytes = await read(input.audioPath);
    const form = new FormData();
    form.append('model', input.model);
    form.append('response_format', 'verbose_json');
    if (input.language) form.append('language', input.language);
    form.append(
      'file',
      new Blob([bytes], { type: 'audio/mpeg' }),
      path.basename(input.audioPath),
    );

    let resp: Response;
    try {
      resp = await fetch(`${this.baseUrl}/v1/audio/transcriptions`, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(10 * 60 * 1000),
      });
    } catch (e) {
      throw new LMStudioError('LM Studio transcribe failed: network', e);
    }
    if (!resp.ok) throw new LMStudioError(`LM Studio ${resp.status} on /v1/audio/transcriptions`);
    const body = (await resp.json()) as {
      text: string;
      segments?: { start: number; end: number; text: string }[];
    };
    return { text: body.text, segments: body.segments ?? [] };
  }
}
