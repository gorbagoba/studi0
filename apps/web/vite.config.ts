/// <reference types="vitest/config" />
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

// ports come from repo-root .env / real env — same source as apps/server/src/config.ts
// (loadEnv includes process.env, which wins over .env values, same as the server)
const env = loadEnv('development', resolve(import.meta.dirname, '..', '..'), '');

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: Number(env.VITE_PORT ?? 5173),
    proxy: { '/api': `http://127.0.0.1:${Number(env.PORT) || 3001}` },
  },
  preview: {
    host: '127.0.0.1',
    port: Number(env.PREVIEW_PORT ?? 4173),
  },
  test: {
    environment: 'jsdom',
  },
});
