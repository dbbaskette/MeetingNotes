// electron/renderer/src/lib/context-overflow.ts
//
// Hand-kept twin of CONTEXT_OVERFLOW_MARKER in electron/main/lm-studio/client.ts
// — renderer code can't import main-process modules. The parity test beside
// this file fails the build if the two strings drift, so the Weekly report
// card keeps recognising the client's "prompt is bigger than the loaded
// context" error and drops its generic list of causes.
export const CONTEXT_OVERFLOW_MARKER = 'tokens of context';

export function isContextOverflowError(message: string | null | undefined): boolean {
  return !!message && message.includes(CONTEXT_OVERFLOW_MARKER);
}
