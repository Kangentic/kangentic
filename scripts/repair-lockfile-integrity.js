#!/usr/bin/env node
/**
 * Restore `resolved` and `integrity` on every package-lock.json entry that lost them.
 *
 * Regenerating package-lock.json against a populated node_modules silently drops both
 * fields for every package already on disk: npm reads the installed version out of the
 * on-disk package.json, which since npm 7 carries no `_resolved` / `_integrity`, and
 * writes an entry with neither. Packages NOT on disk (wrong-platform optionals) are
 * resolved from the registry instead and keep full metadata, so the damage is invisible
 * unless you count. It happened here in 4de7b2e9 and cost 1009 of 1211 entries their
 * supply-chain verification, which `npm ci` then skipped in CI and in the signed release
 * build for two months.
 *
 * `npm install --package-lock-only` does NOT repair this: arborist has no reason to
 * re-fetch a manifest for a node whose pinned version already satisfies the range, so it
 * reports "up to date" and rewrites nothing. Hence this script.
 *
 * It is version-preserving by construction. Each entry keeps its pinned `version`; only
 * `resolved` and `integrity` are filled in, read from that exact version's registry
 * manifest. The manifest's own `name` and `version` are asserted against the entry before
 * anything is written, so a key-parsing slip cannot quietly swap one package's tarball
 * into another package's entry.
 *
 * Idempotent. Re-running it on a healthy lockfile reports nothing to do.
 *
 * Usage: node scripts/repair-lockfile-integrity.js
 */

const fs = require('node:fs');
const path = require('node:path');

const LOCKFILE_PATH = path.join(__dirname, '..', 'package-lock.json');
const REGISTRY_BASE_URL = 'https://registry.npmjs.org';
const FETCH_CONCURRENCY = 10;
const FETCH_ATTEMPTS = 3;
const RETRY_DELAY_MS = 500;

/**
 * A lockfile key is a node_modules PATH, not a package name, and two things make the two
 * diverge. Nested installs read `node_modules/@babel/core/node_modules/semver`, whose
 * package is `semver`, so take everything after the LAST `node_modules/` segment. And an
 * npm ALIAS (`wrap-ansi-cjs: npm:wrap-ansi@7.0.0`) is keyed by the alias while carrying
 * the real package in its own `name` field, which wins outright when present.
 */
function packageNameFor(lockfileKey, entry) {
  if (typeof entry.name === 'string' && entry.name.length > 0) return entry.name;
  const marker = 'node_modules/';
  const lastMarkerIndex = lockfileKey.lastIndexOf(marker);
  return lockfileKey.slice(lastMarkerIndex + marker.length);
}

/** The registry's version endpoint wants the scope slash percent-encoded. */
function encodePackageName(packageName) {
  return packageName.replace('/', '%2f');
}

/** `@babel/core` lives at `.../@babel/core/-/core-7.28.0.tgz`, named without its scope. */
function unscopedPackageName(packageName) {
  const slashIndex = packageName.indexOf('/');
  return slashIndex === -1 ? packageName : packageName.slice(slashIndex + 1);
}

/**
 * Packages published before roughly mid-2017 carry only a hex sha1 `dist.shasum`. SRI
 * accepts sha1, so synthesize the form npm itself writes for them.
 */
function integrityFromDist(dist) {
  if (typeof dist.integrity === 'string' && dist.integrity.length > 0) {
    return { integrity: dist.integrity, usedShasumFallback: false };
  }
  if (typeof dist.shasum === 'string' && /^[0-9a-f]{40}$/i.test(dist.shasum)) {
    return {
      integrity: `sha1-${Buffer.from(dist.shasum, 'hex').toString('base64')}`,
      usedShasumFallback: true,
    };
  }
  return null;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function fetchVersionManifest(packageName, version) {
  const url = `${REGISTRY_BASE_URL}/${encodePackageName(packageName)}/${version}`;
  let lastError = null;

  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { accept: 'application/vnd.npm.install-v1+json, application/json' },
      });
      // A 404 is a real answer, not a transient failure. Do not burn retries on it.
      if (response.status === 404) {
        throw new Error(`registry returned 404 for ${packageName}@${version}`);
      }
      if (!response.ok) {
        throw new Error(`registry returned ${response.status} for ${packageName}@${version}`);
      }
      return await response.json();
    } catch (error) {
      lastError = error;
      if (String(error.message).includes('404')) break;
      if (attempt < FETCH_ATTEMPTS) await delay(RETRY_DELAY_MS * attempt);
    }
  }

  throw lastError ?? new Error(`could not fetch ${packageName}@${version}`);
}

/**
 * Resolve one entry into the two fields it is missing, refusing anything whose manifest
 * does not describe exactly the package and version the entry pins.
 */
async function resolveEntry(lockfileKey, entry) {
  const packageName = packageNameFor(lockfileKey, entry);
  const { version } = entry;

  if (typeof version !== 'string' || version.length === 0) {
    throw new Error(`${lockfileKey}: entry has no version to resolve`);
  }

  const manifest = await fetchVersionManifest(packageName, version);

  if (manifest.name !== packageName) {
    throw new Error(
      `${lockfileKey}: manifest names "${manifest.name}", expected "${packageName}" (key parsed wrong?)`,
    );
  }
  if (manifest.version !== version) {
    throw new Error(
      `${lockfileKey}: manifest is version ${manifest.version}, entry pins ${version}`,
    );
  }

  const dist = manifest.dist ?? {};
  if (typeof dist.tarball !== 'string' || dist.tarball.length === 0) {
    throw new Error(`${lockfileKey}: manifest has no dist.tarball`);
  }

  const expectedTarballName = `${unscopedPackageName(packageName)}-${version}.tgz`;
  const actualTarballName = dist.tarball.slice(dist.tarball.lastIndexOf('/') + 1);
  if (actualTarballName !== expectedTarballName) {
    throw new Error(
      `${lockfileKey}: tarball is "${actualTarballName}", expected "${expectedTarballName}"`,
    );
  }

  const integrityResult = integrityFromDist(dist);
  if (!integrityResult) {
    throw new Error(`${lockfileKey}: manifest has neither dist.integrity nor dist.shasum`);
  }

  return {
    resolved: dist.tarball,
    integrity: integrityResult.integrity,
    usedShasumFallback: integrityResult.usedShasumFallback,
  };
}

/**
 * npm writes an alias entry's `name` first, then `version`, `resolved`, `integrity`, then
 * the rest. Rebuild in that order so the diff is purely additive and a later
 * `npm install` does not reshuffle the file.
 */
function withRestoredMetadata(entry, resolved, integrity) {
  const { name, version, resolved: _oldResolved, integrity: _oldIntegrity, ...rest } = entry;
  const rebuilt = {};
  if (name !== undefined) rebuilt.name = name;
  rebuilt.version = version;
  rebuilt.resolved = resolved;
  rebuilt.integrity = integrity;
  return { ...rebuilt, ...rest };
}

/** Workspace roots and symlinks legitimately have no registry tarball. */
function needsRepair(lockfileKey, entry) {
  if (!lockfileKey.startsWith('node_modules/')) return false;
  if (entry.link) return false;
  return typeof entry.resolved !== 'string' || typeof entry.integrity !== 'string';
}

async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex++;
      results[currentIndex] = await worker(items[currentIndex]);
    }
  });

  await Promise.all(runners);
  return results;
}

async function main() {
  const originalText = fs.readFileSync(LOCKFILE_PATH, 'utf8');
  const lockfile = JSON.parse(originalText);
  const packages = lockfile.packages ?? {};

  const targetKeys = Object.keys(packages).filter((key) => needsRepair(key, packages[key]));

  if (targetKeys.length === 0) {
    console.log('package-lock.json: every entry already has resolved and integrity. Nothing to do.');
    return;
  }

  console.log(`Repairing ${targetKeys.length} of ${Object.keys(packages).length} lockfile entries.`);

  const outcomes = await runWithConcurrency(targetKeys, FETCH_CONCURRENCY, async (key) => {
    try {
      return { key, value: await resolveEntry(key, packages[key]) };
    } catch (error) {
      return { key, error: error.message };
    }
  });

  const failures = outcomes.filter((outcome) => outcome.error);
  if (failures.length > 0) {
    console.error(`\n${failures.length} entries could not be resolved. Nothing was written.`);
    for (const failure of failures) console.error(`  ${failure.error}`);
    process.exitCode = 1;
    return;
  }

  let shasumFallbackCount = 0;
  for (const outcome of outcomes) {
    if (outcome.value.usedShasumFallback) shasumFallbackCount++;
    packages[outcome.key] = withRestoredMetadata(
      packages[outcome.key],
      outcome.value.resolved,
      outcome.value.integrity,
    );
  }

  fs.writeFileSync(LOCKFILE_PATH, `${JSON.stringify(lockfile, null, 2)}\n`);

  console.log(`Repaired ${outcomes.length} entries.`);
  console.log(`  sha1 shasum fallback used for ${shasumFallbackCount} (pre-2017 publishes).`);
  if (shasumFallbackCount > 50) {
    console.log('  That count is high. Check how dist.integrity is being read before trusting it.');
  }
  console.log('\nNow run `npm ci` to verify every restored hash against its tarball.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
