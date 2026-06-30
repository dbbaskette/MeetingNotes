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
        danger: {
          DEFAULT: cssVar('danger'),
          bg: cssVar('danger-bg'),
          text: cssVar('danger-text'),
          border: cssVar('danger-border'),
          solid: cssVar('danger-solid'),
        },
        skeleton: cssVar('skeleton'),
      },
      // Drive the `prose` (Tailwind Typography) colors off the same --ink /
      // --surface CSS variables as the rest of the app. The plugin's stock
      // palette is hardcoded for light backgrounds (body = gray-700, headings
      // = gray-900), so in dark mode the summary preview rendered as dark text
      // on the dark surface — unreadable. Mapping every prose color token to a
      // CSS var means it follows the theme automatically: the variables swap
      // on `.dark`, so we never need `dark:prose-invert`, and the same fix
      // covers WeeklyView's narrative prose too.
      typography: {
        DEFAULT: {
          css: {
            '--tw-prose-body': 'rgb(var(--ink-soft))',
            '--tw-prose-headings': 'rgb(var(--ink))',
            '--tw-prose-lead': 'rgb(var(--ink-soft))',
            '--tw-prose-links': 'rgb(var(--brand-indigo))',
            '--tw-prose-bold': 'rgb(var(--ink))',
            '--tw-prose-counters': 'rgb(var(--ink-muted))',
            '--tw-prose-bullets': 'rgb(var(--ink-muted))',
            '--tw-prose-hr': 'rgb(var(--surface-border))',
            '--tw-prose-quotes': 'rgb(var(--ink-soft))',
            '--tw-prose-quote-borders': 'rgb(var(--surface-border))',
            '--tw-prose-captions': 'rgb(var(--ink-muted))',
            '--tw-prose-code': 'rgb(var(--ink))',
            '--tw-prose-pre-code': 'rgb(var(--ink-soft))',
            '--tw-prose-pre-bg': 'rgb(var(--surface-sunken))',
            '--tw-prose-th-borders': 'rgb(var(--surface-border))',
            '--tw-prose-td-borders': 'rgb(var(--surface-border))',
          },
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
