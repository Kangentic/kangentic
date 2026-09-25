#!/usr/bin/env node
/**
 * Release gate: prove the installed node_modules tree already matches
 * package-lock.json, without deleting anything.
 *
 * The release pre-flight used to run `npm ci`, which deletes node_modules. The
 * team dogfoods Kangentic from `npm start`, so on every release the live dev
 * server was running Electron out of the directory `npm ci` was about to
 * remove. On Windows that usually fails with EBUSY and halts the release; when
 * it succeeds it breaks the running dev server instead. Either way the operator
 * got a judgment call in the middle of a release, which is how this step became
 * a prompt rather than a gate.
 *
 * npm already writes node_modules/.package-lock.json to describe the tree it
 * installed. Comparing that against package-lock.json answers the only question
 * `npm ci` was being asked, and answers it in milliseconds with no writes. An
 * entry may be absent only when npm had a reason not to install it here: it is
 * optional, or its os/cpu constraints exclude this machine.
 *
 * Exits 0 when the tree matches, 1 when it does not (install, then re-run), and
 * 2 when the tree has never been installed at all.
 *
 * Usage: node scripts/verify-node-modules.js [--quiet]
 */

const { readFileSync, existsSync } = require('node:fs');
const path = require('node:path');

const repositoryRoot = path.resolve(__dirname, '..');
const lockfilePath = path.join(repositoryRoot, 'package-lock.json');
const installedManifestPath = path.join(repositoryRoot, 'node_modules', '.package-lock.json');

function readJsonFile(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

/**
 * npm resolves optional and platform-gated dependencies at install time, so the
 * lockfile legitimately lists packages this machine must not have.
 */
function isExcludedFromThisPlatform(lockEntry) {
  if (lockEntry.optional || lockEntry.devOptional) return true;
  if (Array.isArray(lockEntry.os) && !lockEntry.os.includes(process.platform)) return true;
  if (Array.isArray(lockEntry.cpu) && !lockEntry.cpu.includes(process.arch)) return true;
  return false;
}

function compareTrees(lockfile, installedManifest) {
  const missing = [];
  const wrongVersion = [];

  for (const [packagePath, lockEntry] of Object.entries(lockfile.packages)) {
    if (!packagePath.startsWith('node_modules/')) continue;

    const installedEntry = installedManifest.packages[packagePath];
    if (!installedEntry) {
      if (!isExcludedFromThisPlatform(lockEntry)) missing.push(packagePath);
      continue;
    }

    // A workspace link carries a resolved path rather than a version.
    if (lockEntry.link || installedEntry.link) continue;

    if (lockEntry.version !== installedEntry.version) {
      wrongVersion.push({
        packagePath,
        expected: lockEntry.version,
        installed: installedEntry.version,
      });
    }
  }

  const extraneous = Object.keys(installedManifest.packages).filter(
    (packagePath) => !lockfile.packages[packagePath],
  );

  return { missing, wrongVersion, extraneous };
}

function reportSample(label, items, format) {
  if (items.length === 0) return;
  console.error(`  ${items.length} ${label}:`);
  for (const item of items.slice(0, 10)) console.error(`    ${format(item)}`);
  if (items.length > 10) console.error(`    ... and ${items.length - 10} more`);
}

function main() {
  const quiet = process.argv.includes('--quiet');

  if (!existsSync(installedManifestPath)) {
    console.error('node_modules has never been installed in this checkout.');
    console.error('Run `npm ci` before releasing.');
    return 2;
  }

  const lockfile = readJsonFile(lockfilePath);
  const installedManifest = readJsonFile(installedManifestPath);

  if (lockfile.lockfileVersion !== installedManifest.lockfileVersion) {
    console.error(
      `Lockfile version ${lockfile.lockfileVersion} does not match the installed tree's ` +
        `${installedManifest.lockfileVersion}. Run \`npm ci\` before releasing.`,
    );
    return 1;
  }

  const { missing, wrongVersion, extraneous } = compareTrees(lockfile, installedManifest);
  const total = missing.length + wrongVersion.length + extraneous.length;

  if (total > 0) {
    console.error('node_modules does not match package-lock.json.');
    reportSample('missing', missing, (packagePath) => packagePath);
    reportSample(
      'at the wrong version',
      wrongVersion,
      (item) => `${item.packagePath}: expected ${item.expected}, installed ${item.installed}`,
    );
    reportSample('not in the lockfile', extraneous, (packagePath) => packagePath);
    console.error('Run `npm ci` before releasing. Close the dev server first if it is running.');
    return 1;
  }

  if (!quiet) {
    const checked = Object.keys(installedManifest.packages).length;
    console.log(`node_modules matches package-lock.json (${checked} packages). No install needed.`);
  }
  return 0;
}

if (require.main === module) process.exit(main());

module.exports = { compareTrees, isExcludedFromThisPlatform };
