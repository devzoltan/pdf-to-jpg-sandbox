import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 180_000,
    hookTimeout: 360_000,
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
