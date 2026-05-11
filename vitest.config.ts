/// <reference types="vitest" />
// Vitest config — separate from vite.config.ts so test setup doesn't
// pollute the dev/build pipeline. The two configs share the React
// plugin so JSX in tests compiles via the same toolchain.

import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    // jsdom — minimal DOM for Testing Library queries. happy-dom is
    // faster but has gaps that bite (intersection observer, range
    // primitives) so we accept the perf hit for fidelity.
    environment: 'jsdom',
    globals:     true,
    // jest-dom matchers (toBeInTheDocument, etc.) get registered here
    // so individual test files don't have to import them. Single
    // setup file keeps the per-test imports tight.
    setupFiles:  ['./src/test/setup.ts'],
    // .test.{ts,tsx} colocated next to the source under test.
    include:     ['src/**/*.test.{ts,tsx}'],
    // Restore mocks between tests so a mocked fetch in one test
    // doesn't leak into the next.
    restoreMocks: true,
    clearMocks:   true,
  },
});
