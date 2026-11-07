const fs = require('fs');
const path = require('path');
const { listPackage, statFile } = require('@electron/asar');

/**
 * Release gate: no source map ships in the package.
 *
 * Maps are uploaded to Sentry and deleted, and a negated pattern in electron-builder.yml's
 * `files` keeps out the ones node_modules carries. Those are two separate guards with
 * nothing checking the result, so a dropped line would ship the sources in every
 * installer with every job green.
 *
 * Runs from build/afterPack.js rather than as a release workflow step, so it stops a
 * leg before it signs or uploads anything to the draft, and package-smoke.yml runs it
 * on a pull request. The asar header lists unpacked files too, so one listing covers
 * both `app.asar` and `app.asar.unpacked`.
 *
 * See .claude/rules/release-gates-fail-loudly.md.
 */

/** Always in the asar. Finding it proves the listing read the real package, so a wrong
 *  path or an unreadable header cannot read as a clean one. */
const EXPECTED_ENTRY = '.vite/build/index.js';

const MAX_LISTED_MAPS = 20;

/** `listPackage` gives `\`-separated, leading-separator paths on Windows. */
function normalizeEntry(entry) {
  return entry.split(path.sep).join('/').replace(/^\/+/, '');
}

/** `statFile` splits on `path.sep`, so a `/` path is not found on Windows. It returns a
 *  node that has `files` only for a directory, and `some.map/` can be one. */
function isFile(asarPath, entry) {
  return !('files' in statFile(asarPath, entry.split('/').join(path.sep)));
}

function verifyNoSourceMaps({ asarPath, log = console.log }) {
  if (!fs.existsSync(asarPath)) {
    throw new Error(
      `[afterPack] no app.asar at ${asarPath}, so nothing can prove the package carries no source `
      + 'maps. electron-builder.yml sets `asar: true`; if that changed, this gate has to change with it.',
    );
  }
  const entries = listPackage(asarPath).map(normalizeEntry);
  if (!entries.includes(EXPECTED_ENTRY)) {
    throw new Error(
      `[afterPack] ${asarPath} does not list ${EXPECTED_ENTRY}, so this listing cannot prove the `
      + 'package carries no source maps.',
    );
  }
  const maps = entries.filter((entry) => entry.endsWith('.map') && isFile(asarPath, entry));
  if (maps.length > 0) {
    const listed = maps.slice(0, MAX_LISTED_MAPS).join('\n  ');
    const remainder = maps.length > MAX_LISTED_MAPS ? `\n  ...and ${maps.length - MAX_LISTED_MAPS} more` : '';
    throw new Error(
      `[afterPack] ${maps.length} source map file(s) in the package would ship the sources in every `
      + `installer:\n  ${listed}${remainder}\n`
      + 'Check the `!**/*.map` line in `files` in electron-builder.yml, and that the Sentry upload '
      + 'in scripts/build.js and vite.config.mts still deletes its maps.',
    );
  }
  log(`[afterPack] no source maps in the package (${entries.length} asar entries checked)`);
}

module.exports = { verifyNoSourceMaps };
