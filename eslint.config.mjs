// @ts-check
import { defineConfig } from 'eslint/config';
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default defineConfig(
  // packages/launcher is deliberately zero-dep plain CommonJS with no build
  // step; packages/protocol IS linted under the same strict rules as src/
  // and tests/ below (see the `packages/protocol/src/**` entry in the next
  // block's `files`), so it is NOT in this ignore list.
  { ignores: ['node_modules/', '.vite/', '.kangentic/', 'dist/', 'build/', 'packages/launcher/'] },
  eslint.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}', 'tests/**/*.{ts,tsx}', 'packages/protocol/src/**/*.ts'],
    // The preset React's own docs name (react.dev, "ESLint plugin"): rules-of-hooks
    // and exhaustive-deps plus the React Compiler rules. There is no separate JSX
    // plugin: React recommends none, and eslint-plugin-react (our old source of
    // react/jsx-key) has no ESLint 10 release. React's dev runtime still warns on
    // a missing key.
    extends: [reactHooks.configs.flat['recommended-latest']],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      // TypeScript strict
      '@typescript-eslint/no-explicit-any': 'error',
      // Terminal/PTY/ANSI parsers legitimately match control chars (\x1b, \x07, ...) in
      // regexes. no-control-regex targets accidental control chars; here they are
      // intentional, so it is off for the TypeScript source and tests.
      'no-control-regex': 'off',
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        destructuredArrayIgnorePattern: '^_',
      }],
      // We do not run React Compiler. This rule only reports that the compiler
      // would skip memoizing a component that calls TanStack Virtual's
      // useVirtualizer (five sites), which has no code-side fix.
      'react-hooks/incompatible-library': 'off',
    },
  },
  {
    files: ['src/main/agent/*.js'],
    languageOptions: {
      globals: { ...globals.node },
      sourceType: 'commonjs',
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
      'no-undef': 'off',
    },
  },
  {
    // ESM plugin files injected into agent CLIs; they run in Node.
    files: ['src/main/agent/**/*.mjs'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
);
