import { defineConfig } from 'vitest/config';

// Pin the test timezone so date/day-boundary tests don't depend on the host
// zone (the dev machine may be in the US). Workers inherit this env.
process.env.TZ = 'Asia/Shanghai';

export default defineConfig({
  test: {
    // spike/ holds standalone behaviour-check scripts ("7/7 SDK checks pass"
    // harnesses) run directly during development — they are not vitest
    // suites, so exclude them from the test run.
    // packages/** are workspace members with their own vitest configs;
    // they're exercised by `npm run test --workspaces --if-present`.
    exclude: ['**/node_modules/**', '**/dist/**', 'spike/**', 'packages/**'],
    server: {
      deps: {
        external: ['undici'],
      },
    },
  },
});
