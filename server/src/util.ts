import { createHash } from 'node:crypto';
export const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
export class ServiceError extends Error {
  constructor(
    public code: string,
    public status = 422,
    public retryable = false,
  ) {
    super(code);
  }
}
export function log(
  event: string,
  fields: {
    jobId?: string;
    phase?: string;
    code?: string;
    durationMs?: number;
    bytes?: number;
    requestId?: string;
    attempts?: number;
    rssBytes?: number;
  } = {},
) {
  console.log(JSON.stringify({ time: new Date().toISOString(), event, ...fields }));
}

// Bounded labels only: route templates, fixed provider names, and fixed stage names.
const buckets = [10, 50, 100, 500, 1000, 5000, 30000, 120000, Infinity];
const measurements = new Map<
  string,
  { count: number; errors: number; sumMs: number; buckets: number[] }
>();
export function observe(operation: string, durationMs: number, failed: boolean) {
  const value = measurements.get(operation) ?? {
    count: 0,
    errors: 0,
    sumMs: 0,
    buckets: buckets.map(() => 0),
  };
  value.count++;
  value.errors += Number(failed);
  value.sumMs += durationMs;
  buckets.forEach((upper, i) => {
    if (durationMs <= upper) value.buckets[i]++;
  });
  measurements.set(operation, value);
}
export function metrics() {
  return {
    bucketUpperMs: buckets.map((v) => (Number.isFinite(v) ? v : 'inf')),
    operations: Object.fromEntries(measurements),
  };
}
