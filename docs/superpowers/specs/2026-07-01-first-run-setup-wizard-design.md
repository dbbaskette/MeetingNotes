# First-run Setup Wizard — Design

**Date:** 2026-07-01
**Status:** Proposed

## Problem

A new install has to pay four "taxes" before the pipeline can run end-to-end
(mic + system-audio permission, a Whisper STT model, an HF diarization token, a
reachable LLM with a model loaded). The app already ships a first-run wizard —
`electron/renderer/src/views/OnboardingView.tsx`, gated on `settings.onboardedAt`
— that covers those four. But the LLM-readiness education added since (provider
auto-detection, reasoning-model badges, the health-check canary, the STT `/health`
probe) lives only in `SettingsView`, discovered **after** a first meeting fails:

- `api.llm.detectProviders()` — is `lms` / `ollama` installed and already listening?
  Only surfaced in the Settings "Summary provider" dropdown.
- `isKnownReasoningModel(modelId)` (🧠 badge) + `api.llm.healthCheckModel(modelId)`
  (`{ verdict: 'ok' | 'loops' }` canary) — only wired into the Settings model picker.
- `api.stt.probe(url)` (`{ ok }` / `{ ok:false, error }`) and `api.llm.probe(url)` —
  only reachable via the Settings "Test" buttons.

The onboarding LLM step (`LlmStep`) is thin: it lists models via `api.models.list()`,
lets the user pick one, and saves it. It does **not** detect providers, badge
reasoning models, run the canary, or verify the STT endpoint. So a user can finish
onboarding having picked a reasoning model that loops, or with an STT server that
isn't actually answering — and only learns it when the first real meeting fails.

The wizard is also **one-shot**: it renders only while `onboardedAt` is null and has
**no re-open path** — there is no "Run setup again" button in Settings and no menu
item (the string on `SettingsView.tsx:258` is prose, not a control).

## Decision

**Enhance the existing `OnboardingView`; do not build a parallel wizard.** Move the
failure-time LLM/STT education into setup time by:

1. Adding provider detection, reasoning badges, and the health-check canary to the
   existing LLM step, giving it a per-step status (pending → checking → ok/warn).
2. Adding an **STT verification step** that probes `sttUrl` via `api.stt.probe`.
3. Making the wizard **re-openable** from Settings (a "Run setup again" button) and
   from the View menu, not just auto-shown on first run.
4. Extracting the two pieces of real logic — the **first-run gate** and the
   **per-step status machine** — into pure, unit-tested functions, keeping the React
   shell thin (matching the `reasoning-models.ts` / `transcript-lines.ts` pattern).

The wizard **orchestrates existing IPC** — no new pipeline logic, no new model calls.
It reuses `detectProviders`, `probe` (llm + stt), `healthCheckModel`, `models.list`,
`permissions.audio` / `permissions.micStatus` / `permissions.requestMic`, and
`onboarding.*` exactly as they exist today.

### Considered alternatives

- **A new routed `SetupWizardView` alongside `OnboardingView`:** duplicates the step
  chrome, the `onboardedAt` gate, and the permissions/whisper/hf steps. Two wizards
  to keep in sync. Rejected — enhance the one that exists.
- **A modal/overlay (portal) wizard:** the app reserves portals for non-blocking
  overlays (`Toasts`, `SearchPalette`); blocking first-run flows use an **inline
  conditional in `App.tsx`** (`OnboardingView`, `PermissionsModal`). Matching that,
  the wizard stays an inline view, not a portal. Rejected the portal.
- **A new `setupCompleted` boolean setting:** `settings.onboardedAt` (ISO string or
  null) is already exactly the first-run gate, already read in `App.tsx:135-140` and
  written in `OnboardingView.tsx:31`. A second flag would be redundant and would need
  its own migration. Rejected — reuse `onboardedAt`. (See "First-run detection.")

## First-run detection

The gate already exists and needs no schema change: `settings.onboardedAt: string | null`
(`settings-repo.ts:66-68`, default `null` at line 146). The settings table is a
key/value store where a missing key falls back to `DEFAULT_SETTINGS`
(`settings-repo.ts:181-189`), so **no SQL migration is required** for the wizard —
`onboardedAt` is a pre-existing field, and any new field we add would likewise fall
back to its default without a migration.

The decision "should the wizard auto-show" is currently inline in `App.tsx`:

```ts
const all = (await api.settings.getAll()) as { onboardedAt: string | null };
setOnboardStatus(all.onboardedAt ? 'done' : 'needed');
```

This ternary is the whole first-run rule, but it is **untestable** where it sits.
We extract it into a pure function so it can be unit-tested and reused by the re-open
path (which forces the wizard open regardless of `onboardedAt`):

```ts
// electron/renderer/src/lib/setup-wizard.ts
export function firstRunStatus(
  onboardedAt: string | null,
  opts?: { forceOpen?: boolean },
): 'needed' | 'done' {
  if (opts?.forceOpen) return 'needed';
  return onboardedAt ? 'done' : 'needed';
}
```

Completing **or** skipping the wizard stamps `onboardedAt` (existing behavior,
`OnboardingView.finish`), so it never re-auto-shows. Re-opening from Settings passes
`forceOpen: true` without clearing `onboardedAt`, so a re-run doesn't reset the
"has onboarded" fact.

## Step model (pure status machine)

The current `OnboardingView` tracks only an integer `idx` and each step manages its
own ad-hoc booleans (`checking`, `installing`, `err`). The spec calls for a **linear
stepper with per-step status: pending / checking / ok / warn** where a user may
proceed past a **warn** (e.g. a reasoning model or a probe that failed) but the risk
stays visible. We model that as a pure reducer, unit-tested in isolation:

```ts
// electron/renderer/src/lib/setup-wizard.ts
export type StepStatus = 'pending' | 'checking' | 'ok' | 'warn';

/** Whether the wizard lets the user advance from a step in the given status.
 *  Blocks only while a check is in flight; 'warn' is explicitly advanceable so
 *  a user who knowingly keeps a reasoning model (or an unreachable STT server
 *  they'll fix later) is never trapped. */
export function canAdvance(status: StepStatus): boolean {
  return status !== 'checking';
}

/** Fold a probe/canary outcome into a step status. Keeps the mapping in one
 *  tested place instead of scattered ternaries in the React step components. */
export function statusFromProbe(
  outcome: { ok: boolean } | { verdict: 'ok' | 'loops' } | null,
): StepStatus {
  if (outcome == null) return 'pending';
  if ('verdict' in outcome) return outcome.verdict === 'ok' ? 'ok' : 'warn';
  return outcome.ok ? 'ok' : 'warn';
}
```

`warn` (not `error`) is deliberate: every risk in this flow is proceed-able. A looping
model, an unreachable STT server, or an unverifiable audio-capture grant are all things
the user can knowingly move past and fix later — the wizard makes the risk visible, it
does not block.

## Wizard steps and the existing IPC each reuses

The enhanced `STEPS` array (currently `['permissions', 'whisper', 'hf', 'llm']`):

| # | Step | What it does | Existing IPC reused | Verdict → status |
|---|------|--------------|---------------------|------------------|
| 1 | **permissions** | Mic + Screen/System-Audio grant (unchanged) | `permissions.micStatus`, `permissions.audio`, `permissions.requestMic`, `onboarding.openExternal` | see "Audio" below |
| 2 | **whisper** | Download a Whisper model (unchanged) | `onboarding.listWhisperModels`, `onboarding.installWhisperModel` | `ok` if ≥1 installed |
| 3 | **hf** | Save HF diarization token (unchanged) | `onboarding.saveHfToken`, direct `fetch` whoami, `onboarding.openExternal` | `ok` on valid token |
| 4 | **llm** (enhanced) | (a) detect providers, (b) choose model with 🧠 badge, (c) auto-run canary | `llm.detectProviders`, `models.list`, `llm.healthCheckModel`, `isKnownReasoningModel` | `statusFromProbe(healthCheck)`; reasoning model → `warn` |
| 5 | **stt** (new) | Verify the transcription endpoint answers | `stt.probe(sttUrl)` | `statusFromProbe(probe)` |

Step 4's three sub-behaviors mirror `SettingsView` verbatim:

- **Detect providers** — `api.llm.detectProviders()` → `{ lmStudio: {binary, running},
  ollama: {binary, running} }`. Used to tell the user "LM Studio CLI found / already
  running" vs. "not installed", the same hint `SettingsView.tsx:109-114` renders.
- **Model picker + badge** — `api.models.list()` → `string[]`; each option prefixed
  `🧠` when `isKnownReasoningModel(m)` (`SettingsView.tsx:145-149`).
- **Canary** — on model pick, `api.llm.healthCheckModel(modelId)` →
  `{ verdict: 'ok' | 'loops', checkedAt }`, folded through `statusFromProbe`.
  `loops` → `warn` with the same copy `SettingsView.tsx:162` uses ("looped on a quick
  extraction test — expect it to fail on real meetings too"). A `warn` is advanceable.

Step 5 calls `api.stt.probe(s.sttUrl)`. The handler fetches `<url>/health` and checks
for `{"status":"ok"}` (`handlers.ts:833-856`), so a green STT step is a **real**
signal the transcription server is up — unlike audio capture (below).

## Audio capture — honest verifiability

What the app can programmatically verify vs. what it can only instruct, verified
against source (`electron/main/permissions/audio.ts`):

**Verifiable (authoritative):**
- **Microphone.** `getMicAccessStatus()` calls Electron
  `systemPreferences.getMediaAccessStatus('microphone')`, which queries TCC against
  the app's own identity (`audio.ts:35-47`). `granted` / `denied` / `not-determined`
  are trustworthy. `requestMicAccess()` (`askForMediaAccess`) triggers the real OS
  dialog. This is the source of truth `App.tsx:145-150` and `PermissionsModal` already
  rely on — the step can honestly show ✓ Granted.
- **STT server reachable.** `stt.probe` → real `/health` check (step 5, above).
- **Whisper model present.** `onboarding.listWhisperModels()` inspects the models
  directory — a real on-disk check.

**NOT honestly verifiable (must instruct, not assert):**
- **Screen & System Audio Recording (system-audio capture).**
  `probeAudioPermissions()` shells the bundled helper's `--probe-permissions`
  (`audio.ts:56-72`), but its own doc comment says: *"the helper's audio-capture probe
  is best-effort (Apple does not expose a stable API for 'would CoreAudio Process Tap
  succeed')."* `App.tsx:143-146` goes further: the helper's audio-capture check
  *"falsely reports 'granted' because its audio_capture check creates an empty tap
  which always succeeds."* The real grant is only proven when the CoreAudio Process
  Tap runs on the **first Record click**, which is when macOS shows the prompt.

**Design consequence:** the audio-capture row must be **honest**. It shows the mic
grant as a verified ✓ (authoritative), but for system-audio it **instructs** rather
than asserts — the existing copy is already correct and we keep it verbatim:

> "macOS will also prompt for 'Screen & System Audio Recording' the first time you
> click Record — you can skip the System Settings button and grant it then."
> (`OnboardingView.tsx:174-178`)

The step's status is derived only from the **authoritative** signals: `ok` when mic
is `granted` (and audio-capture is not explicitly `denied`), otherwise `warn` — never
a false green from the empty-tap probe. This mirrors `PermissionsModal.tsx:23`'s rule
(`micState === 'granted' && audioPerms.audioCapture !== 'denied'`). We do **not**
gate advancement on a "verified" system-audio capture, because it cannot be verified
before the first recording.

## Re-open from Settings

`OnboardingView` renders inside `App.tsx`'s inline conditional
(`onboardStatus === 'needed'`). To re-open it:

- Add a **"Run setup again"** button to `SettingsView`. It calls back to `App` to set
  `onboardStatus = 'needed'` **with `forceOpen`** — i.e. show the wizard without
  clearing `onboardedAt` (so a cancelled re-run leaves the "onboarded" fact intact).
- Wire the existing **View menu** action pattern (`App.tsx:168-189`,
  `api.onMenuAction`) so a `run-setup` menu action opens it too. (Menu registration in
  main is out of scope for the renderer plan; the renderer just handles the action if
  present. This is called out as an open question below.)

Because `firstRunStatus(onboardedAt, { forceOpen: true })` returns `'needed'`
regardless of `onboardedAt`, the same code path serves both auto-show and re-open.

## What does not change

- The permissions / whisper / hf steps' behavior and copy (only the shared step
  chrome gains a status pip).
- `onboardedAt`'s semantics, default, or storage; no migration.
- Every IPC signature — the wizard is a pure consumer of existing channels. No new
  IPC, so neither `contracts.ts` nor the preload `IPC_CHANNELS` registry changes.
- `SettingsView`'s own model picker / health-check / provider UI — the wizard reuses
  the same IPC and the same `isKnownReasoningModel` lib, it does not refactor Settings.

## Error handling

- **LLM unreachable / no models** (`models.list()` empty or throws): step 4 stays in
  `warn` with the existing "LM Studio isn't reachable" copy and a Re-check button
  (`OnboardingView.tsx:421-427`). Advanceable.
- **Canary throws** (not a loop, e.g. a transport error): treat as best-effort —
  status back to `pending`, don't block, exactly as `SettingsView.tsx:84-86` does.
- **STT probe fails** (`{ ok:false, error }`): step 5 → `warn`, shows `error`,
  advanceable with a Re-check.
- **Mic denied:** step 1 → `warn`, offers Request + System Settings deep-link
  (existing rows). Advanceable — the user can grant later.

## Testing strategy

Pure functions in `electron/renderer/src/lib/setup-wizard.ts`
(`firstRunStatus`, `canAdvance`, `statusFromProbe`) are unit-tested with vitest in
`setup-wizard.test.ts`, matching `reasoning-models.test.ts`'s style (single import,
flat `describe`/`it`, table-ish assertions). The React shell (the enhanced
`OnboardingView`) keeps a **manual verification step**: launch with `onboardedAt` null,
walk all five steps, confirm the LLM step badges a reasoning model + runs the canary,
confirm the STT step goes green against a live whisper-server, then re-open via
Settings and confirm it doesn't wipe `onboardedAt`.

## Accepted trade-off

System-audio capture cannot show a trustworthy ✓ before the first recording (Apple
gives no stable pre-flight API), so that one signal remains an instruction, not a
verified check. The counterweight is that everything else in the flow — mic, STT,
LLM reachability, model health — becomes verifiable at setup time instead of at
first-meeting-failure time, which is the whole point of the feature.
