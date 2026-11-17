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

const bundleDirectory = path.join(REPO_ROOT, UI_BUNDLE_DIRECTORY);
let server;
try {
  server = await startDemoServer({ distDir: bundleDirectory, port: readPort(process.argv.slice(2)), host: 'localhost' });
} catch (error) {
  // startDemoServer's own message names the demo build, which is not what is missing here.
  const reason = error instanceof Error ? error.message : String(error);
  throw new Error(`[ui-bundle] Cannot serve ${UI_BUNDLE_DIRECTORY}: ${reason} Run "npm run build:ui-bundle" first.`);
}
console.log(`[ui-bundle] serving ${UI_BUNDLE_DIRECTORY} at ${server.url}`);
