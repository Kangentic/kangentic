#!/usr/bin/env node
/**
 * Build the web demo: `npm run build:demo [-- --base=/kangentic/]`.
 *
 * Pins NODE_ENV=production before Vite starts, for the same reason scripts/build.js does: Vite
 * keeps an ambient NODE_ENV, and a shell that exports "development" (an IDE, a parent process)
 * silently ships React's development build and every `import.meta.env.DEV` branch in a bundle
 * that reports success. demo/vite.config.mts refuses to build unless the value is pinned, so a
 * bare `vite build --config demo/vite.config.mts` from such a shell fails loudly instead.
 *
 * Every extra argument is forwarded to `vite build` (the GitHub Pages deploy passes `--base`).
 */
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const previous = process.env.NODE_ENV;
process.env.NODE_ENV = 'production';
console.log(`[build:demo] NODE_ENV pinned to production${previous && previous !== 'production' ? ` (shell had "${previous}")` : ''}`);

const projectDir = path.resolve(__dirname, '..');
const viteBin = path.join(projectDir, 'node_modules', 'vite', 'bin', 'vite.js');
const forwarded = process.argv.slice(2);

// A Git Bash shell on Windows rewrites a leading-slash argument into a Windows path before node
// ever sees it ("--base=/kangentic/" arrives as "--base=C:/Program Files/Git/kangentic/"), and
// Vite only warns. A deploy on that base would 404 every asset, so refuse it here.
for (const argument of forwarded) {
  const match = /^--base=(.*)$/.exec(argument);
  if (match && !match[1].startsWith('/')) {
    console.error(`[build:demo] --base must start with a slash, got ${JSON.stringify(match[1])}. On Windows a Git Bash shell rewrites the value; run from PowerShell or set MSYS_NO_PATHCONV=1.`);
    process.exit(1);
  }
}

// The config imports extensionless .ts files from src/ and tests/captures/, which Vite's native
// config loader cannot load. Vite 8 already defaults to the bundle loader, and its own warning
// says `native` is planned to become the default in a later major, so the build pins `bundle`.
// That warning prints on every bundle-loaded build, so the spawn env sets
// VITE_CONFIG_NATIVE_IGNORE_WARNING to silence it. Remove the env var together with the pin.
const args = [viteBin, 'build', '--configLoader', 'bundle', '--config', path.join(projectDir, 'demo', 'vite.config.mts'), ...forwarded];
const env = { ...process.env, VITE_CONFIG_NATIVE_IGNORE_WARNING: 'true' };
const result = spawnSync(process.execPath, args, { cwd: projectDir, stdio: 'inherit', env });
if (result.error) {
  console.error('[build:demo] could not start vite:', result.error);
  process.exit(1);
}
process.exit(result.status ?? 1);
