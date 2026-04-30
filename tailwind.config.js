import typography from '@tailwindcss/typography';

// Color tokens are sourced from CSS custom properties defined in
// renderer/src/index.css (`:root` for light, `.dark` for dark). That keeps
// the per-class JSX (e.g. `bg-surface`, `text-ink-muted`) identical across
// modes — the variables swap; the classnames don't move. The `<alpha-value>`
// suffix lets Tailwind opacity modifiers like `text-ink/70` keep working
// against the custom properties.
const cssVar = (name) => `rgb(var(--${name}) / <alpha-value>)`;

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./electron/renderer/index.html', './electron/renderer/src/**/*.{ts,tsx}'],
  // Class-based so the App can opt-in via OS preference + user override
  // rather than being forced by media query alone.
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        ink: {
          DEFAULT: cssVar('ink'),
          soft: cssVar('ink-soft'),
          muted: cssVar('ink-muted'),
        },
        surface: {
          DEFAULT: cssVar('surface'),
          sunken: cssVar('surface-sunken'),
          border: cssVar('surface-border'),
        },
        brand: {
          indigo: cssVar('brand-indigo'),
          violet: cssVar('brand-violet'),
          gradient: 'linear-gradient(135deg,#6366f1,#8b5cf6)',
        },
        status: {
          ok: cssVar('status-ok'),
          okBg: cssVar('status-ok-bg'),
          warn: cssVar('status-warn'),
          warnBg: cssVar('status-warn-bg'),
          warnText: cssVar('status-warn-text'),
          processing: cssVar('status-processing'),
          processingBg: cssVar('status-processing-bg'),
        },
      },
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', 'Inter', 'sans-serif'],
      },
      boxShadow: {
        card: '0 1px 3px rgba(0,0,0,0.08)',
        pop: '0 10px 40px rgba(0,0,0,0.08)',
      },
      borderRadius: { xl: '14px' },
    },
  },
  // Drives the `prose` classes used by the summary preview's markdown
  // renderer. Without this plugin `prose`/`prose-sm` silently resolve to
  // nothing and headings/lists/tables render unstyled.
  plugins: [typography],
};
