export class LMStudioError extends Error {
  constructor(message: string, public cause?: unknown) {
    super(message);
  }
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
}
