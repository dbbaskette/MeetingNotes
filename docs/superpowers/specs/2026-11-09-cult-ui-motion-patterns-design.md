# Cult UI motion patterns — design

Date: 2026-11-09. Status: approved by the owner in session.

## Goal

Bring four interaction patterns from Cult UI into the renderer to make the
interface feel more alive, without adopting the Cult UI registry or shadcn.
The patterns are written by hand against the app's Tailwind 3 tokens and use
the `motion` library for animation.

## Constraints

- One new dependency: `motion`. No shadcn setup, Sonner, Base UI or vaul.
- Golden Gate rules hold: animation on chrome and transient surfaces only.
  Meeting rows, notes and transcript text do not animate.
- The macOS Reduce Motion setting must disable the springs. The app is wrapped
  in `MotionConfig reducedMotion="user"`.
- The production CSP is unchanged (`style-src 'unsafe-inline'` already covers
  inline style attributes).
- No behaviour changes to recording, recovery, or toast call sites.

## Shared pieces

New folder `electron/renderer/src/components/motion/`:

| File | Purpose |
|---|---|
| `spring.ts` | The one spring setting and durations every pattern uses. |
| `Expandable.tsx` | Animates children open and closed by height with `AnimatePresence`. Props: `open`, `id`, `children`. |
| `SlidingPill.tsx` | Renders behind the selected item of a group and glides in from the group's last position using the Web Animations API (no inline styles left behind; works across views that each render their own nav). Props: `group`, `className`. |
| `features.ts` | The `motion` feature bundle, loaded on demand through `LazyMotion` so it stays out of the startup chunk. Components use `m.*`, not `motion.*`. |
| `RecordingPill.tsx` | Compact recording indicator that expands to the full controls. |

`LazyMotion` and `MotionConfig` are added in `App.tsx` around `AppInner`.

Measured cost (production build): the startup chunk went from 218.6 kB to
270.3 kB (62.2 → 80.3 kB gzip), plus a 52 kB (20 kB gzip) chunk loaded after
first paint. Toasts animate their height instead of using `layout`, which
would need the larger feature set.

## 1. Expandable panels

- `RecoveryRow`: the Delete confirmation and Preview/trim panels are wrapped
  in `Expandable`. Ids and `aria-controls` are kept.
- `NeedsAttentionPanel`: the header gains a collapse toggle
  (`aria-expanded`, `aria-controls`). Collapsed, the panel shows one line of
  per-group counts, for example "1 failed · 1 speaker review · 2 ready to
  process". The choice is stored in localStorage under
  `needsAttentionCollapsed`. The body animates with `Expandable`.
- Pure helper `lib/attention-summary.ts` builds the collapsed line and
  reads/writes the preference; it is unit-tested.

## 2. Sliding pills and tabs

- `AppNav`, the Organized / All meetings toggle in `LibraryView`, and
  `SettingsNavigation` render `SlidingPill` inside the selected button. The
  static selected background in `index.css` moves from the button to the pill.
- Meeting detail tabs become a real tab list: `role="tablist"`, `role="tab"`,
  `aria-selected`, `aria-controls`, roving `tabIndex`, Left/Right/Home/End
  keys. The selected tab shows a sliding underline. Tab content does not
  animate.
- Pure helper `lib/tab-keys.ts` maps a key and current index to the next
  index; it is unit-tested.

## 3. Toasts

- `ToastHost` renders the list inside `AnimatePresence` with `layout` so
  toasts slide in from the right, slide out, and reflow.
- Timers pause while a toast is hovered or focused and resume with the
  remaining time.
- `variant: 'error'` toasts use `role="alert"` and are sticky unless the call
  passes `durationMs`.
- At most four toasts are visible; older ones are hidden until space frees up.
- `useToast()` keeps its API.
- Timer and cap logic lives in `lib/toast-queue.ts`, unit-tested.

## 4. Recording pill

- On every view except the Library, `App.tsx` renders `RecordingPill` at the
  top centre in place of the full-width `LiveRecordingRow` banner.
- Collapsed: red dot, elapsed time, a small level meter, accessible name
  "Recording, <elapsed>. Show controls".
- Expanded (click, Enter or Space): the pill grows in place into a popover
  containing the existing `LiveRecordingRow`, so stop, two-step confirm and
  restart behave exactly as today. Esc or an outside click collapses it,
  unless a stop is being confirmed inside a dialog.
- The Library keeps its inline `LiveRecordingRow`.

## Testing

- Vitest unit tests for `attention-summary`, `tab-keys` and `toast-queue`.
- Renderer preview check in light, dark and with reduced motion emulated.
- `npm test` and a production build; report the startup chunk size before and
  after.

## Out of scope

Bug fixes from the 2026-11-09 review (progress fan-out, missing-meeting
skeleton, drag-and-drop import, ⌘R outside the Library), a shared Button
component, and any Cult UI component not listed above.
