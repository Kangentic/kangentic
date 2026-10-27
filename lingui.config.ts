// Lingui configuration: which locales exist, where each area's catalog lives, and
// how catalogs are written. docs/architecture/i18n.md explains the layout and
// .claude/rules/i18n.md the conventions.
import { defineConfig } from '@lingui/cli';
import { formatter } from '@lingui/format-po';
import { APP_LOCALES, SOURCE_LOCALE } from './src/shared/i18n/locales';

export default defineConfig({
  sourceLocale: SOURCE_LOCALE,
  locales: [...APP_LOCALES],
  // A message a catalog has not translated yet shows its English.
  fallbackLocales: { default: SOURCE_LOCALE },
  // File origins give a translator, and the translation harness, the context a
  // short string needs. Without line numbers: with them, any edit that shifts a
  // line in a file holding a message changed all 15 locales' PO files, so every
  // such PR failed the catalog gate until re-extracted, and parallel branches
  // conflicted in 15 files at once. The harness finds a message in its file by text.
  format: formatter({ origins: true, lineNumbers: false }),
  // One PO file per area, so tasks that extract different areas never edit the
  // same file. The four entries cover every source file exactly once, and no two
  // write the same file: tests/unit/i18n-boundaries.test.ts fails on a file that
  // reaches none or two catalogs, and on two catalogs sharing a path.
  catalogs: [
    // One catalog per folder under components/ (settings.po, dialogs.po,
    // shared.po for components/shared...).
    {
      path: '<rootDir>/src/locales/{locale}/{name}',
      include: ['<rootDir>/src/renderer/components/{name}/'],
      exclude: ['<rootDir>/src/renderer/components/debug/**'],
    },
    // The source roots take a `src-` name, which no component folder can collide
    // with. The rest of the renderer: root component files, hooks, stores, lib, utils.
    {
      path: '<rootDir>/src/locales/{locale}/src-renderer',
      include: ['<rootDir>/src/renderer/'],
      exclude: ['<rootDir>/src/renderer/components/*/**'],
    },
    // Lists main and the renderer both import (keybindings, automation manifest).
    {
      path: '<rootDir>/src/locales/{locale}/src-shared',
      include: ['<rootDir>/src/shared/'],
    },
    // Native menus, message boxes and notifications. The renderer never loads it.
    {
      path: '<rootDir>/src/locales/{locale}/src-main',
      include: ['<rootDir>/src/main/'],
    },
  ],
  // `lingui compile` merges every area into one catalog per locale for main,
  // which cannot import PO files. The renderer loads the PO files themselves
  // through @lingui/vite-plugin, which ignores this setting.
  catalogsMergePath: '<rootDir>/.vite/build/locales/{locale}',
  // Shared lists main imports declare messages with @lingui/core/runtime-macro,
  // which plain esbuild bundles. This makes the extractor read them.
  experimental: { runtimeMacro: true },
});
