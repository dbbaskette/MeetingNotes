import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { contentSecurityPolicy } from './electron/renderer/csp';

export default defineConfig({
  root: 'electron/renderer',
  base: './',
  plugins: [
    react(),
    {
      // Production builds only; see electron/renderer/csp.ts.
      name: 'meetingnotes-csp',
      apply: 'build',
      transformIndexHtml: () => [{
        tag: 'meta',
        attrs: { 'http-equiv': 'Content-Security-Policy', content: contentSecurityPolicy() },
        injectTo: 'head-prepend',
      }],
    },
  ],
  resolve: {
    alias: { '@renderer': path.resolve(__dirname, 'electron/renderer/src') },
  },
  server: { port: 5174, strictPort: true },
  build: {
    outDir: path.resolve(__dirname, 'dist/renderer'),
    emptyOutDir: true,
  },
});
