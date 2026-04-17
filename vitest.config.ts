import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['electron/**/*.test.ts', 'electron/**/*.test.tsx'],
    coverage: { provider: 'v8', reporter: ['text', 'html'] },
  },
  resolve: {
    alias: {
      '@main': path.resolve(__dirname, 'electron/main'),
      '@renderer': path.resolve(__dirname, 'electron/renderer/src'),
    },
  },
});
