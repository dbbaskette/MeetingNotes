// electron/main/logging/renderer-error.ts
//
// Renderer crash reports arrive over IPC from error boundaries and the
// window-level error listeners. The payload is untrusted and can be produced
// in a tight loop by a component that throws on every render, so it is
// validated, truncated and rate-limited before it reaches the log file.

import { z } from 'zod';

const MAX_MESSAGE = 500;
const MAX_STACK = 4000;

const RendererErrorSchema = z.object({
  source: z.enum(['boundary', 'window', 'promise']),
  scope: z.string().max(80),
  message: z.string(),
  stack: z.string().optional(),
  componentStack: z.string().optional(),
});

export interface RendererErrorEntry {
  source: 'boundary' | 'window' | 'promise';
  scope: string;
  message: string;
  stack?: string;
  componentStack?: string;
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** Returns a bounded log entry, or null when the payload is malformed. */
export function normalizeRendererError(input: unknown): RendererErrorEntry | null {
  const parsed = RendererErrorSchema.safeParse(input);
  if (!parsed.success) return null;
  const { source, scope, message, stack, componentStack } = parsed.data;
  return {
    source,
    scope,
    message: clip(message, MAX_MESSAGE),
    ...(stack ? { stack: clip(stack, MAX_STACK) } : {}),
    ...(componentStack ? { componentStack: clip(componentStack, MAX_STACK) } : {}),
  };
}

/** Sliding-window limiter: at most `limit` accepted reports per `windowMs`. */
export function createReportLimiter(limit = 20, windowMs = 60_000, now: () => number = Date.now): () => boolean {
  let accepted: number[] = [];
  return () => {
    const t = now();
    accepted = accepted.filter((at) => t - at < windowMs);
    if (accepted.length >= limit) return false;
    accepted.push(t);
    return true;
  };
}
