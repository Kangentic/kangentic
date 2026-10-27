#!/usr/bin/env node
/**
 * The Lingui catalog steps every build path shares: the Node floor Lingui 6
 * needs, the gate that the catalogs match the source, and the compile that
 * gives main its catalogs. Used by scripts/build.js (the release build:
 * release.yml runs it through `npm run publish`), scripts/build-demo.js
 * (deploy-demo.yml), scripts/dev.js, and the `i18n:*` npm scripts.
 *
 *   node scripts/i18n-catalogs.js check     the catalog gate (`npm run i18n:check`)
 *   node scripts/i18n-catalogs.js compile   main's catalogs (`npm run i18n:compile`)
 *
 * Why a stale catalog must stop a build: a production renderer keeps only each
 * message's ID (Lingui strips the English), so a message missing from the
 * catalogs renders as a raw ID like `z3fd2`. See docs/architecture/i18n.md.
 */
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

/** Lingui 6 ships ESM only and declares `engines.node >=22.19.0`. */
const MINIMUM_NODE = [22, 19, 0];

/**
 * Fail loudly below Lingui 6's Node floor. release.yml and deploy-demo.yml ask
 * setup-node for `22`, which resolves to whatever 22.x the runner image caches;
 * this turns a too-old one into a named failure instead of an ESM loader error.
 */
function assertNodeSupportsLingui(version = process.versions.node) {
  const parts = version.split('.').map((part) => Number.parseInt(part, 10));
  for (let index = 0; index < MINIMUM_NODE.length; index++) {
    const actual = parts[index] ?? 0;
    if (actual > MINIMUM_NODE[index]) return;
    if (actual < MINIMUM_NODE[index]) {
      throw new Error(
        `::error::Node ${version} is below ${MINIMUM_NODE.join('.')}, which Lingui 6 (the i18n catalogs) `
        + 'requires. Set the workflow\'s node-version to 22.19 or newer, or 24.',
      );
    }
  }
}

/** The Lingui CLI's entry script, read from its package.json `bin`. */
function linguiCliPath(projectDir) {
  const packageEntry = require.resolve('@lingui/cli', { paths: [projectDir] });
  let directory = path.dirname(packageEntry);
  while (!fs.existsSync(path.join(directory, 'package.json'))) {
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error('[i18n] Could not find @lingui/cli/package.json');
    directory = parent;
  }
  const packageJson = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
  const bin = typeof packageJson.bin === 'string' ? packageJson.bin : packageJson.bin?.lingui;
  if (!bin) throw new Error('[i18n] @lingui/cli/package.json names no lingui bin');
  return path.join(directory, bin);
}

/** Run the Lingui CLI in the project and return its exit status. */
function runLingui(projectDir, args) {
  const result = spawnSync(process.execPath, [linguiCliPath(projectDir), ...args], {
    cwd: projectDir,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

/**
 * The catalog gate: every message in the source is in the catalogs (`check
 * sync`, which fails exactly when `lingui extract` would change a file), and
 * English has nothing missing. Throws, naming the fix, when either fails.
 */
function checkCatalogs(projectDir) {
  if (runLingui(projectDir, ['check', 'sync', '--clean', '--verbose']) !== 0) {
    throw new Error(
      '::error::The i18n catalogs do not match the source: a message was added, changed or removed '
      + 'without re-extracting. Run `npm run i18n:extract` and commit src/locales.',
    );
  }
  if (runLingui(projectDir, ['check', 'missing', '--locale', 'en', '--verbose']) !== 0) {
    throw new Error('::error::The English catalog is missing messages. Run `npm run i18n:extract` and commit src/locales.');
  }
  console.log('[i18n] Catalogs are current: they match the source and English is complete');
}

/** `lingui compile` writing main's merged JSON catalogs; both compiles below run it. */
const COMPILE_FOR_MAIN_ARGUMENTS = ['compile', '--namespace', 'json'];
const COMPILED_FOR_MAIN_MESSAGE = '[i18n] Compiled the catalogs for main into .vite/build/locales';

/**
 * Compile one merged catalog per locale for main (`.vite/build/locales/<locale>.json`,
 * lingui.config.ts `catalogsMergePath`). `strict` fails when a message is still
 * missing after the English fallback, which the release build wants and a dev
 * session with catalogs not yet re-extracted does not.
 */
function compileCatalogsForMain(projectDir, { strict }) {
  const args = [...COMPILE_FOR_MAIN_ARGUMENTS, ...(strict ? ['--strict'] : [])];
  if (runLingui(projectDir, args) !== 0) {
    throw new Error('::error::Could not compile the i18n catalogs for the main process (lingui compile).');
  }
  console.log(COMPILED_FOR_MAIN_MESSAGE);
}

/**
 * The dev session's compile: not strict, since a dev session runs with messages
 * not yet re-extracted (main shows their English), and in the background beside
 * the esbuild builds. Resolves true when it compiled; a failure only warns, since
 * main then runs in English. It never rejects: scripts/dev.js awaits it only
 * after the Vite server is up, and a rejection before that would reach its
 * unhandledRejection handler and end the boot.
 */
function compileCatalogsForMainInBackground(projectDir) {
  return new Promise((resolve) => {
    let cliPath;
    try {
      cliPath = linguiCliPath(projectDir);
    } catch (error) {
      console.warn('[i18n] Could not find the Lingui CLI; main runs in English:', error instanceof Error ? error.message : error);
      resolve(false);
      return;
    }
    const child = spawn(process.execPath, [cliPath, ...COMPILE_FOR_MAIN_ARGUMENTS], {
      cwd: projectDir,
      stdio: ['ignore', 'ignore', 'inherit'],
      windowsHide: true,
    });
    child.on('error', (error) => {
      console.warn('[i18n] Could not start lingui compile; main runs in English:', error.message);
      resolve(false);
    });
    child.on('close', (exitCode) => {
      if (exitCode === 0) console.log(COMPILED_FOR_MAIN_MESSAGE);
      else console.warn(`[i18n] lingui compile exited ${exitCode}; main runs in English.`);
      resolve(exitCode === 0);
    });
  });
}

module.exports = {
  assertNodeSupportsLingui,
  checkCatalogs,
  compileCatalogsForMain,
  compileCatalogsForMainInBackground,
  linguiCliPath,
  runLingui,
};

if (require.main === module) {
  const projectDir = path.resolve(__dirname, '..');
  const command = process.argv[2];
  try {
    assertNodeSupportsLingui();
    if (command === 'check') checkCatalogs(projectDir);
    else if (command === 'compile') compileCatalogsForMain(projectDir, { strict: true });
    else throw new Error(`Usage: node scripts/i18n-catalogs.js <check|compile>, got ${JSON.stringify(command)}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
