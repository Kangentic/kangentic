#!/usr/bin/env node
/**
 * Runs the UI tier the way CI does: against the static bundle, not the Vite dev server.
 *
 * Builds dist/ui-bundle (scripts/build-ui-bundle.mjs), then runs `playwright test --project=ui`
 * with KANGENTIC_UI_BUNDLE=1 and whatever arguments it was given. Use it to reproduce a spec that
 * fails on CI and passes on the dev server. A plain `npx playwright test --project=ui` stays on
 * the dev server, which needs no build and shows an edit on the next run.
 *
 * Usage: npm run test:ui:bundle -- tests/ui/some.spec.ts
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildUiBundle } from './build-ui-bundle.mjs';
import { resolvePlaywrightCli } from './lib/playwright-cli.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The build sets NODE_ENV for vite. The run below gets back what this process started with.
const startingNodeEnv = process.env.NODE_ENV;
await buildUiBundle();
if (startingNodeEnv === undefined) delete process.env.NODE_ENV;
else process.env.NODE_ENV = startingNodeEnv;

const run = spawnSync(
  process.execPath,
  [resolvePlaywrightCli(), 'test', '--project=ui', ...process.argv.slice(2)],
  { cwd: REPO_ROOT, stdio: 'inherit', env: { ...process.env, KANGENTIC_UI_BUNDLE: '1' } },
);
process.exit(run.status ?? 1);
