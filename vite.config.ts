import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const apiTarget = `http://localhost:${process.env.PORT ?? 4000}`;

export default defineConfig({
  root: path.resolve(import.meta.dirname, 'client'),
  // Separate cache directories let several dev servers run side by side.
  cacheDir: process.env.VITE_CACHE_DIR ?? path.resolve(import.meta.dirname, 'node_modules/.vite'),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'client/src'),
      '@shared': path.resolve(import.meta.dirname, 'shared'),
    },
  },
  server: {
    port: Number(process.env.VITE_PORT ?? 5173),
    host: true,
    proxy: { '/api': { target: apiTarget, changeOrigin: false } },
  },
  build: {
    outDir: path.resolve(import.meta.dirname, 'dist/client'),
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
});
