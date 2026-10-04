import { defineConfig } from 'vitest/config'

// Builds the package and both fixture apps, then runs their standalone servers. Slow; run with `npm run test:e2e`.
export default defineConfig({
  test: {
    include: ['test/e2e/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 900_000,
    fileParallelism: false,
  },
})
