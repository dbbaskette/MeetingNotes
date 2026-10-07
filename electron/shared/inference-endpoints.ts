export type WhisperEndpoint = { kind: 'managed'; host: string; port: number }
  | { kind: 'external' } | { kind: 'invalid'; reason: string };

/** Only a root, plain-HTTP loopback endpoint can be backed by a local
 * whisper-server. TLS, remote hosts and reverse-proxy paths are user-managed. */
export function resolveWhisperEndpoint(endpoint: string): WhisperEndpoint {
  let url: URL;
  try { url = new URL(endpoint); }
  catch { return { kind: 'invalid', reason: 'Invalid STT URL — enter a complete HTTP or HTTPS URL in Settings.' }; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    return { kind: 'invalid', reason: 'STT URL must use HTTP or HTTPS without embedded credentials.' };
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const loopback = host === 'localhost' || host === '::1' || /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(host);
  if (url.protocol !== 'http:' || !loopback || url.pathname !== '/' || url.search || url.hash) {
    return { kind: 'external' };
  }
  return { kind: 'managed', host, port: url.port ? Number(url.port) : 80 };
}

export type LLMProvider = 'external' | 'lm-studio' | 'ollama';
export function effectiveLlmUrl(provider: LLMProvider, externalUrl: string): string {
  return provider === 'lm-studio' ? 'http://127.0.0.1:1234'
    : provider === 'ollama' ? 'http://127.0.0.1:11434' : externalUrl;
}

/** Generic fetch failures may mean DNS, TLS, or timeout, never just idle. */
export function isIdleProbe(managed: boolean, code?: string): boolean {
  return managed && code === 'ECONNREFUSED';
}
