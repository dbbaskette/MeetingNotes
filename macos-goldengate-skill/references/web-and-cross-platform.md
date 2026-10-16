# Web, React and web-rendered desktop shells

## Preserve the current stack

Implement this as a coherent token/component refresh in the existing framework. Do not add a native dependency, change routing or rewrite the app to obtain the style. Inspect existing themes, global resets, scroll owners, overlays and component states before changing shared selectors. Prefer semantic classes/tokens over broad selectors that accidentally alter unrelated nested components.

The goal is an integrated shell and readable content. A persistent header may share one material plane with task-grouped controls; content groups are usually flatter, with disclosure, indentation and selection carrying structure. Keep existing virtualized list geometry and a single intentional scroll owner. If row sizes change, update the actual measurement/virtualization contract rather than hiding overflow.

## CSS material is an approximation

Use a translucent fill plus modest `backdrop-filter` on a few chrome/transient surfaces. The underlying background must support readable contrast. Prefer opacity and a simple edge when blur is unavailable. Do not use filters on every row, giant offscreen textures, permanent animation loops or pointer-driven shaders to imitate liquid effects.

Example starting point, to adapt to the existing theme rather than paste as a universal recipe:

```css
.app {
  --chrome-fill: rgb(238 243 249 / 88%);
  --chrome-fallback: #eef3f9;
  --content-fill: #fafbfd;
  --text-primary: #233143;
  --material-edge: rgb(70 90 120 / 24%);
  color: var(--text-primary);
}
.app[data-theme="dark"] {
  --chrome-fill: rgb(34 42 55 / 92%);
  --chrome-fallback: #222a37;
  --content-fill: #19212d;
  --text-primary: #eff3fa;
  --material-edge: rgb(206 221 244 / 28%);
}
.app-chrome {
  background: var(--chrome-fallback);
  border-bottom: 1px solid var(--material-edge);
}
@supports (backdrop-filter: blur(12px)) {
  .app-chrome {
    background: var(--chrome-fill);
    backdrop-filter: blur(12px) saturate(1.15);
  }
}
.app[data-reduce-transparency="true"] .app-chrome {
  background: var(--chrome-fallback);
  backdrop-filter: none;
}
@media (prefers-reduced-transparency: reduce) {
  .app-chrome {
    background: var(--chrome-fallback);
    backdrop-filter: none;
  }
}
```

Keep text colors opaque and validate them on the composed background. Support `prefers-reduced-motion` and `prefers-contrast` where available. Browser support varies; the base rule above is deliberately usable without those queries or blur. Respect existing app appearance/preferences before creating new settings.

## Electron, Tauri and hybrid apps

The desktop shell may expose native vibrancy, material, appearance or accessibility notifications. Check its installed version and official API documentation before using them. CSS blur is not evidence that the OS glass-tint setting is honored. A native material bridge is a separate implementation choice, not an automatic requirement of the style request.

Retain native titlebar/traffic-light hit targets, drag regions, keyboard commands, window focus behavior and security settings. Do not disable context isolation/sandboxing, expose arbitrary native calls, or add another custom titlebar solely for an effect. Changes to window transparency/material can affect composition and software rendering: verify normal rendering and the project's existing GPU-disabled fallback where supported. Do not copy user libraries or grant permissions just to take a screenshot.

## Verify a representative slice

Exercise a real populated view, not only an empty first-run screen. Check narrow/default/wide sizes, zoom, long labels, light/dark, focus/hover/selection/disabled/error states, overlays, reduced effects and scroll stability. Measure when the change affects large lists or animation; a static screenshot cannot establish performance. Reuse the project's existing UI fixtures and test cadence.
