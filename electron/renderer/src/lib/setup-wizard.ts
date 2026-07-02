// electron/renderer/src/lib/setup-wizard.ts
//
// Pure logic for the first-run setup wizard, extracted from OnboardingView so
// the two real decisions — "should the wizard show" and "how does a probe/canary
// outcome map to a step's status" — are unit-testable and reused by both the
// auto-show path (App.tsx) and the "Run setup again" re-open path (SettingsView).
// The React shell stays thin; everything with a branch lives here.

/** Whether the first-run wizard should be shown. `onboardedAt` is the existing
 *  gate (settings-repo.ts): null = never onboarded. `forceOpen` re-opens the
 *  wizard from Settings without clearing that fact, so a cancelled re-run leaves
 *  the "has onboarded" state intact. */
export function firstRunStatus(
  onboardedAt: string | null,
  opts?: { forceOpen?: boolean },
): 'needed' | 'done' {
  if (opts?.forceOpen) return 'needed';
  return onboardedAt ? 'done' : 'needed';
}

/** Per-step status in the linear stepper.
 *   - pending  : not checked yet
 *   - checking : a probe/canary is in flight (only state that blocks advancing)
 *   - ok       : verified good
 *   - warn     : a proceed-able risk (reasoning model, unreachable STT, denied
 *                mic) — visible but never blocking. */
export type StepStatus = 'pending' | 'checking' | 'ok' | 'warn';

/** The wizard lets the user advance from any status except an in-flight check.
 *  'warn' is intentionally advanceable — see StepStatus. */
export function canAdvance(status: StepStatus): boolean {
  return status !== 'checking';
}

/** Fold a probe result ({ ok }) or a health-check verdict ({ verdict }) into a
 *  step status. One tested mapping instead of ternaries scattered across the
 *  React step components. `null` = not run yet -> pending. */
export function statusFromProbe(
  outcome: { ok: boolean } | { verdict: 'ok' | 'loops' } | null,
): StepStatus {
  if (outcome == null) return 'pending';
  if ('verdict' in outcome) return outcome.verdict === 'ok' ? 'ok' : 'warn';
  return outcome.ok ? 'ok' : 'warn';
}
