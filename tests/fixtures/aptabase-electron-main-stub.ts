/**
 * Unit-tier stand-in for `@aptabase/electron/main`, wired via the alias in
 * vitest.config.ts.
 *
 * Why it exists: the real package ships ESM whose top level does
 * `import { app, ipcMain, net, protocol } from 'electron'`. Under plain-node
 * vitest the `electron` package is its CJS stub (a string export), and Node's
 * ESM linker rejects those named imports at LINK time - so any test whose
 * import graph merely reaches `src/main/analytics/analytics.ts` fails before
 * it runs. Suites that assert on analytics behavior keep their own
 * `vi.mock('@aptabase/electron/main', ...)`, which overrides this alias; this
 * stub only keeps the import graph loadable for everyone else.
 */
export function initialize(): Promise<void> {
  return Promise.resolve();
}

export function trackEvent(): Promise<void> {
  return Promise.resolve();
}
