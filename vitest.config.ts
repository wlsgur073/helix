import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Rebuild bin/ before every run so the acceptance suite always exercises
    // bundles built from CURRENT src (a stale committed bundle must not pass for src).
    globalSetup: ['./test/setup/build-bundles.ts'],
  },
});
