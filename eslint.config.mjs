// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactPlugin from 'eslint-plugin-react';
import reactHooksPlugin from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  // packages/launcher is deliberately zero-dep plain CommonJS with no build
  // step; packages/protocol IS linted under the same strict rules as src/
  // and tests/ below (see the `packages/protocol/src/**` entry in the next
  // block's `files`), so it is NOT in this ignore list.
  { ignores: ['node_modules/', '.vite/', '.kangentic/', 'dist/', 'build/', 'packages/launcher/'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}', 'tests/**/*.{ts,tsx}', 'packages/protocol/src/**/*.ts'],
    plugins: {
      'react-hooks': reactHooksPlugin,
    },
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

      // React hooks - catches stale closures and rules-of-hooks violations
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    files: ['src/**/*.tsx'],
    ...reactPlugin.configs.flat['jsx-runtime'],
    rules: {
      // Missing keys in .map() JSX - catches real bugs
      'react/jsx-key': 'error',
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
