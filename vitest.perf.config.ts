import { defineConfig } from 'vitest/config';

/** Real-time performance tests, run one file at a time on an otherwise idle test runner. */
export default defineConfig({
  test: {
    globals: true,
    include: ['tests/perf/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['tests/setup.ts'],
    fileParallelism: false,
  },
});
