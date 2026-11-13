/**
 * The Playwright CLI entry demo/posters.mjs and demo/poster-gate.mjs spawn with process.execPath,
 * so no shell is involved on any OS.
 *
 * Its own module because it needs `import.meta`, and scripts/lib/demo-posters.mjs must not: the
 * capture specs import that module, and Playwright compiles what a spec imports to CommonJS, where
 * `import.meta` is a syntax error.
 */
import { createRequire } from 'node:module';

export function resolvePlaywrightCli() {
  try {
    return createRequire(import.meta.url).resolve('@playwright/test/cli');
  } catch {
    throw new Error('@playwright/test is not installed (its cli entry did not resolve). Run "npm ci" first.');
  }
}
