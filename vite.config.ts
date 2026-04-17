import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  root: 'electron/renderer',
  base: './',
  plugins: [react()],
  resolve: {
    alias: { '@renderer': path.resolve(__dirname, 'electron/renderer/src') },
  },
  server: { port: 5173, strictPort: true },
  build: {
    outDir: path.resolve(__dirname, 'dist/renderer'),
    emptyOutDir: true,
  },
});
