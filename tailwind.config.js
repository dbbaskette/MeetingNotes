/** @type {import('tailwindcss').Config} */
export default {
  content: ['./electron/renderer/index.html', './electron/renderer/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: { DEFAULT: '#1c1917', soft: '#44403c', muted: '#78716c' },
        surface: { DEFAULT: '#ffffff', sunken: '#fafaf9', border: '#e7e5e4' },
        brand: {
          indigo: '#6366f1',
          violet: '#8b5cf6',
          gradient: 'linear-gradient(135deg,#6366f1,#8b5cf6)',
        },
        status: {
          ok: '#16a34a',
          okBg: '#dcfce7',
          warn: '#f59e0b',
          warnBg: '#fef3c7',
          warnText: '#92400e',
          processing: '#6366f1',
          processingBg: '#e0e7ff',
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
  plugins: [],
};
