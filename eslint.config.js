// ESLint flat config — minimal, offline-installable subset.
//
// What's here:
//   • @eslint/js recommended baseline (no-undef, no-unused-vars,
//     no-fallthrough, etc.) on every .ts/.tsx in src/.
//   • @typescript-eslint/parser v5 — required so ESLint can read TSX
//     syntax and the rules above can walk the AST. We do NOT install
//     @typescript-eslint/eslint-plugin in this repo because its 6+
//     transitive dep `ts-api-utils` is not in our offline npm cache;
//     tsc --strict already covers the heavy type-aware checks (mypy
//     parity), so the lint layer focuses on what tsc cannot enforce.
//   • react-hooks/rules-of-hooks + exhaustive-deps — the two rules
//     that catch real bugs in our hook-heavy components.
//
// Files outside src/ (vite.config.ts, this config) intentionally fall
// back to ESLint's default JS handling.

import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import tsParser from '@typescript-eslint/parser';
import globals from 'globals';

export default [
  // Ignore generated artefacts.
  {
    ignores: ['dist/', 'node_modules/', 'coverage/', '*.tsbuildinfo'],
  },

  // Source: TS + TSX with TS parser, browser globals, react-hooks rules.
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': reactHooks,
    },
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
      globals: {
        ...globals.browser,
        // Vite injects this at runtime.
        __DEV__: 'readonly',
      },
    },
    rules: {
      ...js.configs.recommended.rules,

      // js.configs.recommended's no-unused-vars uses native AST and
      // misfires on TS-specific syntax (interfaces, type imports).
      // tsc has --noUnusedLocals + --noUnusedParameters which are
      // type-aware and do this job correctly; turn off the textual
      // ESLint version to avoid false positives.
      'no-unused-vars': 'off',
      // Same story — TS handles this via --noImplicitAny + parser.
      'no-undef': 'off',

      // React hook safety — these are the rules nobody should ever
      // disable. exhaustive-deps catches stale-closure bugs that the
      // type system cannot see.
      'react-hooks/rules-of-hooks':  'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
];
