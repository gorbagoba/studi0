import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // harness-based tests are fast in isolation but intermittently exceed the
    // default 5s on a loaded machine (parallel suite + Defender scanning)
    testTimeout: 20_000,
  },
});
