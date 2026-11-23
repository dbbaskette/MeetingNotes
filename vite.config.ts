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
      // Each page gets its own policy: only beta.html may play beta-audio:.
      transformIndexHtml: (_html, ctx) => [{
        tag: 'meta',
        attrs: { 'http-equiv': 'Content-Security-Policy', content: contentSecurityPolicy(ctx.filename.endsWith('beta.html') ? 'beta' : 'app') },
        injectTo: 'head-prepend',
      }],
    },
  ],
  resolve: {
    alias: { '@renderer': path.resolve(__dirname, 'electron/renderer/src') },
  },
  server: { port: 5174, strictPort: true },
  build: {
    rollupOptions: { input: { main: path.resolve(__dirname, 'electron/renderer/index.html'), beta: path.resolve(__dirname, 'electron/renderer/beta.html') } },
    outDir: path.resolve(__dirname, 'dist/renderer'),
    emptyOutDir: true,
  },
});
