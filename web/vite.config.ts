/// <reference types="vitest/config" />
import { defineConfig } from 'vite';

export default defineConfig({
  // Pure static output, no host-specific config — deployable to Vercel,
  // Cloudflare Pages, or served by the streaming server unchanged.
  build: {
    outDir: 'dist',
  },
  test: {
    environment: 'jsdom',
  },
});
