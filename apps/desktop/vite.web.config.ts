import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Browser preview / web build. It uses the same renderer and talks to the same
 * WebSocket server; native desktop behaviours (always-on-top, capture
 * protection, tray) simply fall away in the browser.
 */
export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  envDir: resolve(__dirname),
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src/renderer/src'),
      '@shared': resolve(__dirname, 'src/shared'),
      '@talkie/protocol': resolve(__dirname, '../../packages/protocol/src/index.ts'),
    },
  },
  server: {
    port: 5175,
    strictPort: true,
    fs: {
      allow: [resolve(__dirname, '../..')],
    },
  },
  build: {
    outDir: resolve(__dirname, 'out-web'),
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(__dirname, 'src/renderer/index.html'),
    },
  },
});
