#!/usr/bin/env node
/**
 * Serves the UI test tier's static bundle (dist/ui-bundle/, from scripts/build-ui-bundle.mjs) on
 * the port the specs load the app from. playwright.config.ts starts it as its `webServer` when
 * KANGENTIC_UI_BUNDLE=1, in place of the Vite dev server.
 *
 * It binds `localhost`, as Vite does, because every spec's URL names that host.
 *
 * Usage: node scripts/serve-ui-bundle.mjs --port 5173
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDemoServer } from '../demo/static-server.mjs';
import { UI_BUNDLE_DIRECTORY } from './build-ui-bundle.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readPort(commandLine) {
  const flagIndex = commandLine.indexOf('--port');
  const port = Number(flagIndex === -1 ? Number.NaN : commandLine[flagIndex + 1]);
  if (!Number.isInteger(port) || port < 1) {
    throw new Error('Usage: node scripts/serve-ui-bundle.mjs --port <port>');
  }
  return port;
}

const port = readPort(process.argv.slice(2));
const bundleDirectory = path.join(REPO_ROOT, UI_BUNDLE_DIRECTORY);
// Checked here, since startDemoServer's own message names the demo build, which is not what is
// missing. Only a missing bundle gets the build hint: a port already in use, or a missing
// --port, is not fixed by building, so each keeps its own message.
if (!fs.existsSync(path.join(bundleDirectory, 'index.html'))) {
  throw new Error(`[ui-bundle] No bundle at ${UI_BUNDLE_DIRECTORY}. Run "npm run build:ui-bundle" first.`);
}
const server = await startDemoServer({ distDir: bundleDirectory, port, host: 'localhost' });
console.log(`[ui-bundle] serving ${UI_BUNDLE_DIRECTORY} at ${server.url}`);
