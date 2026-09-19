import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    // worker/** has its own vitest config (@cloudflare/vitest-pool-workers,
    // imports 'cloudflare:test'); it must not be collected by the jsdom runner.
    exclude: ['**/node_modules/**', '**/dist/**', '**/e2e/**', 'worker/**'],
  },
});
