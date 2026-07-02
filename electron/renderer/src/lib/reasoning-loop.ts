// electron/renderer/src/lib/reasoning-loop.ts
//
// Hand-kept twin of REASONING_LOOP_MARKER in electron/main/lm-studio/client.ts
// — renderer code can't import main-process modules, same reason preload
// duplicates IPC_CHANNELS. The parity test beside this file fails the build
// if the two strings ever drift, so the failure banner's recovery controls
// keep matching the error the client actually throws.
export const REASONING_LOOP_MARKER = 'spent its entire token budget';
