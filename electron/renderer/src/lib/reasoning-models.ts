// Name-pattern match for local models known to reason via chain-of-thought
// before answering. These are the exact four families already named
// consistently throughout this codebase's error messages and comments
// (see LMStudioClient.chat's disableThinking doc in
// electron/main/lm-studio/client.ts) — collected here once so the model
// picker and failure-recovery UI can warn proactively instead of only
// explaining the failure after it happens on a real meeting.
const REASONING_MODEL_PATTERNS = [/gemma/i, /qwen3/i, /deepseek-r1/i, /gpt-oss/i];

export function isKnownReasoningModel(modelId: string): boolean {
  return REASONING_MODEL_PATTERNS.some((p) => p.test(modelId));
}
