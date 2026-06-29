# Light/Dark theme polish — design

Date: 2026-06-29
Status: approved (pending spec review)

## Problem

In macOS dark mode the app looks broken: light chrome/background with dark
cards (see the reported screenshot). The theming architecture is sound — CSS
custom-property palettes (`:root` light, `.dark` dark) wired into Tailwind, a
`.dark` class toggled from `matchMedia` in `App.tsx`. Three things defeat it:

1. **Root cause — body background override.** `electron/renderer/index.html`
   sets `<body class="bg-stone-50">`. That Tailwind utility is a *class*
   selector (specificity 0,1,0) and outranks the themed
   `body { background: rgb(var(--surface-sunken)) }` *element* rule
   (0,0,1) in `index.css`. The page background is therefore pinned to the
   light `stone-50` in every mode. Verified live: with `.dark` on `<html>`
   and `--surface-sunken` resolving to the dark `17 17 21`, `body` still
   paints `rgb(250,250,249)`.

2. **Scattered hardcoded colors** that never adapt. Audit of the renderer
   (`*.tsx`):
   - Error/destructive (~45): `bg-rose-100 text-rose-700` (FAILED badge),
     `bg-rose-600`/`bg-rose-700` (delete buttons), `text-rose-600` /
     `text-red-600` (error text), `bg-rose-50` (failed-row avatar).
   - Skeleton loaders (~35): `bg-stone-200` / `bg-stone-100` pulse blocks.
   - Warnings (~8): `bg-amber-50/200 text-amber-900 border-amber-200`.
   - White-on-saturated (~30): `text-white` on rose/indigo/gradient buttons.
   - Modal scrims (~5): `bg-black/30–40`.
   - `theme/tokens.ts`: light-only hexes (`amberBg`, `amberText`) and the
     speaker palette.

3. **Dark palette contrast is too flat.** Dark `surface` (`24 24 28`) and
   `surface-sunken` (`17 17 21`) sit a hair apart, so cards barely separate
   from the page.

## Goals

- Both modes look intentional and consistent. No light chrome in dark mode.
- A **System / Light / Dark** theme control in Settings (default System);
  Light/Dark override the OS.
- No theme flash on launch.
- Status/error/skeleton colors driven by semantic tokens, not hardcoded
  Tailwind palette classes.

## Non-goals

- No redesign of layout, typography, spacing, or component structure.
- No new views or features beyond the theme control.
- Speaker-avatar palette stays as-is (saturated circles with white text read
  acceptably in both modes); only verified, not re-themed.
- Modal scrims (`bg-black/*`) stay — a translucent dark scrim is correct in
  both modes.

## Design

### 1. Theme control (System / Light / Dark)

- **Setting.** Add `theme: 'system' | 'light' | 'dark'` to `Settings`
  (`settings-repo.ts`), default `'system'`. Surfaced through the existing
  `settings.getAll` / `settings.set` IPC.
- **Resolution helper.** A pure function
  `resolveDark(theme, systemPrefersDark): boolean` — `'dark'`→true,
  `'light'`→false, `'system'`→`systemPrefersDark`. Unit-tested.
- **Apply in renderer (`App.tsx`).** Replace the current matchMedia-only
  effect: read `theme` from settings on mount, toggle `.dark` on
  `<html>` via `resolveDark`, and keep it live by listening to (a) the
  `matchMedia('(prefers-color-scheme: dark)')` change event (only acts when
  theme is `'system'`), and (b) a `mn:theme-changed` window `CustomEvent`
  that `SettingsView` dispatches after `settings.set('theme', …)`.
- **No-flash.** `App` mirrors the active theme to `localStorage['mn-theme']`
  on every apply. A tiny inline script in `index.html` (runs before
  `main.tsx`) reads `localStorage['mn-theme']`, falls back to `matchMedia`,
  and toggles `.dark` before React mounts. Eliminates the first-paint flash;
  React reconciles to the SQLite value immediately after.
- **Native chrome (`electron/main`).** Set `nativeTheme.themeSource` from the
  persisted `theme` at startup and in the `settings.set` IPC handler when the
  key is `theme` (`'system'|'light'|'dark'` map 1:1). Also set the
  `BrowserWindow` `backgroundColor` at creation from the persisted theme so
  the native window paints the right base before the renderer loads. This
  fixes the frameless window's titlebar/traffic-light strip and native
  scrollbars in dark mode.
- **Settings UI.** A segmented **System / Light / Dark** control near the top
  of `SettingsView`, bound to the `theme` setting; on change it persists and
  dispatches `mn:theme-changed`.

### 2. Body-background fix

Remove `bg-stone-50` from `<body>` in `index.html`. The themed
`body { background: rgb(var(--surface-sunken)) }` rule in `index.css` then
drives the page background in both modes.

### 3. Semantic token additions

Add to `index.css` (`:root` + `.dark`) and wire into `tailwind.config.js`
under `theme.extend.colors` using the existing `cssVar()` helper. Values are
space-separated RGB triples (so `<alpha-value>` opacity modifiers keep
working).

**New `danger` family** (the pale rose pills + error text + destructive
buttons):

| Token | Light (rgb) | Dark (rgb) | Use |
|---|---|---|---|
| `--danger` | `220 38 38` | `248 113 113` | `text-danger` (error text/icons) |
| `--danger-bg` | `254 226 226` | `58 20 23` | pale pill / surface bg |
| `--danger-text` | `185 28 28` | `253 164 176` | text on `danger-bg` |
| `--danger-border` | `254 202 202` | `90 35 40` | border on `danger-bg` |
| `--danger-solid` | `220 38 38` | `225 29 72` | saturated destructive button bg (white text) |

**New `skeleton` token** (loaders):

| Token | Light | Dark |
|---|---|---|
| `--skeleton` | `231 229 228` | `45 43 41` |

Tailwind: `colors.danger = { DEFAULT, bg, text, border, solid }`,
`colors.skeleton = DEFAULT`.

### 4. Dark palette tuning (warm charcoal)

Retune the `.dark` neutrals so cards read as elevated above the page and the
dark base feels warm (consistent with the warm-stone light palette). Light
palette unchanged.

| Token | Dark — current | Dark — new |
|---|---|---|
| `--surface` (cards) | `24 24 28` | `33 31 30` |
| `--surface-sunken` (page) | `17 17 21` | `23 22 21` |
| `--surface-border` | `51 51 56` | `56 53 51` |
| `--ink` | `245 245 244` | `245 245 244` (keep) |
| `--ink-soft` | `214 211 209` | `214 211 209` (keep) |
| `--ink-muted` | `168 162 158` | `168 162 158` (keep) |

Cards (`surface`) are now lighter than the page (`surface-sunken`), so the
existing `bg-surface` cards separate via tone + the hairline border. Final
values verified in the live preview and adjusted if needed.

### 5. Component migration

Mechanical find/replace across the 16 affected files, by bucket:

| From | To |
|---|---|
| `bg-rose-100 text-rose-700` (badges/pills) | `bg-danger-bg text-danger-text` |
| `border-rose-200/300` on those pills | `border-danger-border` |
| `text-rose-600` / `text-red-600` (errors) | `text-danger` |
| `bg-rose-600/700` + `text-white` (delete) | `bg-danger-solid text-white` |
| `bg-rose-50` (failed avatar/surfaces) | `bg-danger-bg` |
| `bg-stone-200` / `bg-stone-100` (loaders) | `bg-skeleton` |
| `bg-amber-50/200 text-amber-900 border-amber-200` | `bg-status-warnBg text-status-warnText` (+ `border-status-warn` if a border token is added) |

Leave: `text-white` on saturated colored buttons, brand gradient,
`bg-black/30–40` scrims, `bg-white/20` kbd on the gradient Record button.
Audit `theme/tokens.ts` `amberBg`/`amberText` usages; if used as backgrounds,
replace with `status-warn*` tokens. Speaker palette unchanged.

### 6. Dev-preview shim completion

The in-browser preview (`vite`, no Electron IPC) currently crashes because the
`window.api` shim in `index.html` is missing methods `App.tsx` calls at
startup (e.g. `api.onOpenMeeting`). Complete the shim (add the missing
no-op/stub methods and a `theme` field in the `settings.getAll` stub) so the
UI renders in a plain browser. This is dev-only (guarded by `if (!window.api)`;
the Electron preload sets `window.api` first in production) and is what lets
us screenshot both modes.

## Verification

- Run the `renderer` Vite preview; screenshot Library, MeetingDetail, Weekly,
  Settings, Onboarding, and each modal/banner/toast in **both** light and dark
  via `preview_resize` colorScheme emulation + the in-app toggle. Compare
  against the mockup.
- Confirm no remaining hardcoded `rose/red/stone/amber` background/text classes
  outside the "leave" list (grep).
- `npm test`, `npm run lint` (touched files), both `tsc` projects green.

## Testing

- Unit: `resolveDark` truth table; `settings-repo` returns `'system'` default
  for `theme` and round-trips a set value.
- Visual/behavioral: manual + preview screenshots (CSS theming isn't unit
  testable).

## Files touched

- `electron/renderer/index.html` — remove body class; no-flash inline script; complete dev shim
- `electron/renderer/src/index.css` — body bg already correct; add `danger`/`skeleton` tokens; retune `.dark` neutrals
- `tailwind.config.js` — register `danger`, `skeleton` colors
- `electron/renderer/src/App.tsx` — theme-aware application + `localStorage` mirror + event/matchMedia listeners
- `electron/renderer/src/views/SettingsView.tsx` — segmented theme control
- `electron/main/storage/settings-repo.ts` — `theme` setting + default
- `electron/main/index.ts` (+ window/IPC) — `nativeTheme.themeSource`, `BrowserWindow.backgroundColor`, settings.set hook
- `electron/renderer/src/lib/` — new `resolveDark` helper + test
- Component files with hardcoded colors (LibraryRow, MeetingDetailView, WeeklyView, OnboardingView, MeetingRowMenu, LiveRecordingRow, RecordButton, Toasts, SourcePicker, PermissionsModal, SearchPalette, MeetingDetectedBanner, VuMeter, SearchMatches)

## Notes / out of scope

- Version: ship as a user-facing feature → bump to `1.7.0`, on its own branch
  separate from the pending LLM `disableThinking` change (which is `1.6.4`).
- No persistence migration needed — `theme` defaults via `DEFAULT_SETTINGS`.
