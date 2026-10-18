import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts', 'tests/components/**/*.test.tsx', 'tests/eval/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['tests/setup.ts'],
    // Synthetic audio/video scenes are CPU-heavy; with parallel workers 5 s is too tight.
    testTimeout: 20_000,
  },
});
