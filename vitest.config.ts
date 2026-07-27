import { defineConfig } from 'vitest/config';

/**
 * Node environment, no globals.
 *
 * `globals: false` is the default and is kept deliberately: every test file
 * imports `describe`/`it`/`expect` explicitly, so a file that drifts out of the
 * suite (renamed, moved) fails to compile rather than silently registering
 * nothing.
 *
 * `include` is narrowed to `*.test.ts` so the shared harness modules under
 * `test/` — fixtures tables, temp-directory helpers — are plain modules rather
 * than empty suites.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Installer tests write real files into per-test temp directories and the
    // redaction test stubs process-wide streams, so files must not share a
    // worker. Tests inside one file still run sequentially.
    isolate: true,
    // A hung `deploy(wait: true)` poll or an unclosed mock server should fail
    // the run, not stall CI until the job timeout.
    testTimeout: 20_000,
    hookTimeout: 20_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // Generated code: asserting on it belongs in the codegen check
      // (`npm run codegen && git diff --exit-code`), not in coverage numbers.
      exclude: ['src/generated/**'],
    },
  },
});
