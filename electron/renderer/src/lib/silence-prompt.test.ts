import { describe, expect, it, vi } from 'vitest';
vi.mock('../ipc/client', () => ({ api: { recording: {} } }));
import { createSilencePromptStore, fmtCountdown, SILENCE_AUTO_STOP_REASON, type SilenceBridge, type SilencePrompt } from './silence-prompt';
import { SILENCE_AUTO_STOP_REASON as MAIN_REASON } from '../../../main/recording/manager.js';

function harness(initial: SilencePrompt | null = null) {
  let onPrompt: (p: SilencePrompt) => void = () => {};
  let onCleared: (e: { sessionId: string; reason: 'audio-resumed' | 'continued' | 'stopped' | 'auto-stopped' }) => void = () => {};
  const bridge: Required<SilenceBridge> = {
    continueSilence: vi.fn(async () => {}),
    silenceState: vi.fn(async () => initial),
    onSilencePrompt: (cb) => { onPrompt = cb; return () => { onPrompt = () => {}; }; },
    onSilenceCleared: (cb) => { onCleared = cb; return () => { onCleared = () => {}; }; },
  };
  const store = createSilencePromptStore(() => bridge);
  return { store, bridge, prompt: (p: SilencePrompt) => onPrompt(p), cleared: (sessionId: string) => onCleared({ sessionId, reason: 'audio-resumed' }) };
}
const P: SilencePrompt = { sessionId: 's1', silentForMs: 120_000, autoStopAtMs: 5_000 };

describe('silence prompt store', () => {
  it('shows a pushed prompt and clears it when audio resumes', () => {
    const h = harness();
    const seen: (SilencePrompt | null)[] = [];
    h.store.subscribe(() => seen.push(h.store.get()));
    h.prompt(P);
    h.cleared('s1');
    expect(seen).toEqual([P, null]);
  });

  it('hydrates a prompt that was already pending when the view mounted', async () => {
    const h = harness(P);
    h.store.subscribe(() => {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.store.get()).toEqual(P);
  });

  it('does not let a late snapshot overwrite a newer pushed event', async () => {
    const h = harness(P);
    h.store.subscribe(() => {});
    h.prompt(P); h.cleared('s1'); // cleared before the snapshot resolves
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.store.get()).toBeNull();
  });

  it('ignores a cleared event for another session', () => {
    const h = harness();
    h.store.subscribe(() => {});
    h.prompt(P); h.cleared('other');
    expect(h.store.get()).toEqual(P);
  });

  it('Continue calls main and clears the prompt', async () => {
    const h = harness();
    h.store.subscribe(() => {});
    h.prompt(P);
    await h.store.continueRecording('s1');
    expect(h.bridge.continueSilence).toHaveBeenCalledWith('s1');
    expect(h.store.get()).toBeNull();
  });

  it('shows nothing, and does not throw, when the bridge lacks the feature', async () => {
    const store = createSilencePromptStore(() => ({}));
    const off = store.subscribe(() => {});
    await store.continueRecording('s1');
    expect(store.get()).toBeNull();
    off();
  });

  it('formats the countdown', () => {
    expect(fmtCountdown(45)).toBe('0:45');
    expect(fmtCountdown(65)).toBe('1:05');
    expect(fmtCountdown(-3)).toBe('0:00');
  });

  it('matches the reason the main process sends with an automatic stop', () => {
    expect(SILENCE_AUTO_STOP_REASON).toBe(MAIN_REASON);
  });
});
