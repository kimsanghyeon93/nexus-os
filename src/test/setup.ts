// Vitest setup — registers jest-dom matchers globally + any per-suite
// polyfills the components need (matchMedia, ResizeObserver, fetch).
// Imported once via vitest.config.ts → setupFiles, so individual test
// files don't have to know about it.

import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

// React 18+ Testing Library cleanup — unmounts trees between tests so
// state from one render doesn't leak into the next.
afterEach(() => {
  cleanup();
});

// jsdom doesn't ship matchMedia, several of our components query it
// for prefers-reduced-motion / dark-mode hints — stub once here.
if (typeof window !== 'undefined' && !window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches:           false,
      media:             query,
      onchange:          null,
      addListener:       () => {},
      removeListener:    () => {},
      addEventListener:  () => {},
      removeEventListener: () => {},
      dispatchEvent:     () => false,
    }),
  });
}

// jsdom doesn't ship ResizeObserver — used by some panels that watch
// container size. Stub with a no-op so the components don't crash.
if (typeof window !== 'undefined' && typeof window.ResizeObserver === 'undefined') {
  // @ts-expect-error – minimal shape, intentional
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

// AbortSignal.any polyfill — same fallback our marketApi.ts uses
// internally, but the test environment runs older jsdom which may
// lack it. Cheap to make a no-op fallback so tests don't blow up.
if (typeof AbortSignal !== 'undefined'
 && typeof (AbortSignal as unknown as { any?: unknown }).any !== 'function') {
  (AbortSignal as unknown as { any: (s: AbortSignal[]) => AbortSignal }).any = (signals) => {
    const ctrl = new AbortController();
    for (const s of signals) {
      if (s.aborted) { ctrl.abort(); break; }
      s.addEventListener('abort', () => ctrl.abort(), { once: true });
    }
    return ctrl.signal;
  };
}

// Some component branches log informational messages — silence in
// test mode so the runner output stays clean.
vi.spyOn(console, 'info').mockImplementation(() => {});
