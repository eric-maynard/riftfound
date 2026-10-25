import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    // The ranking helpers under test are pure, so no DOM is needed.
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
