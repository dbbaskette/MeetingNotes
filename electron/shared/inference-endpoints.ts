export type LLMProvider = 'external' | 'lm-studio' | 'ollama';
export function effectiveLlmUrl(provider: LLMProvider, externalUrl: string): string {
  return provider === 'lm-studio' ? 'http://127.0.0.1:1234'
    : provider === 'ollama' ? 'http://127.0.0.1:11434' : externalUrl;
}

/** Generic fetch failures may mean DNS, TLS, or timeout, never just idle. */
export function isIdleProbe(managed: boolean, code?: string): boolean {
  return managed && code === 'ECONNREFUSED';
}
