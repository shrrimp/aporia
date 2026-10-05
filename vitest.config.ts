import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.{ts,tsx}'],
    setupFiles: ['packages/ui/test/setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.{ts,tsx}'],
      // Entry points that need a real runtime are covered by smoke tests instead:
      // serve-main (scripts/), ui main.tsx (browser), desktop/* (packages/desktop/e2e/smoke.ts).
      exclude: ['packages/*/src/**/index.ts', 'packages/server/src/serve-main.ts', 'packages/ui/src/main.tsx', 'packages/desktop/**'],
      thresholds: { branches: 95, functions: 100, lines: 98, statements: 98 },
    },
  },
});
