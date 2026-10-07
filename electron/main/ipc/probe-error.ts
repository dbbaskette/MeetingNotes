export function probeError(error: unknown): { ok: false; error: string; code?: string } {
  const message = error instanceof Error ? error.message : String(error);
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth++) {
    const value = current as { code?: unknown; cause?: unknown };
    if (typeof value.code === 'string') {
      return { ok: false, error: value.code === 'ECONNREFUSED' ? 'connection refused' : message, code: value.code };
    }
    current = value.cause;
  }
  return { ok: false, error: message };
}
