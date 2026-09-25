/**
 * `allowScripts` in package.json is live npm configuration, not a leftover.
 *
 * npm 12 blocks a dependency's `install` / `postinstall` script unless that package
 * is covered by `allowScripts`, and it says so in exactly those words:
 *
 *   8 packages have install scripts blocked because they are not covered by allowScripts
 *
 * Nothing in this repo reads the key, so a grep for a consumer finds only its own
 * definition and it reads as dead config. Deleting it is quiet and expensive: `npm ci`
 * still exits 0, but electron never downloads its binary, better-sqlite3 and node-pty
 * are never compiled, esbuild never fetches its platform binary, and onnxruntime-node
 * never fetches its native providers. The install looks clean and the tree is unusable.
 *
 * This test is what stops that. It derives the required set from the lockfile's own
 * `hasInstallScript` flags rather than from a hand-kept list, so a new native
 * dependency fails here instead of failing mysteriously on someone's next clean
 * install.
 *
 * Tier: Unit.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

interface LockfileEntry {
  hasInstallScript?: boolean;
  dev?: boolean;
  optional?: boolean;
  link?: boolean;
}

function packageNameFor(lockfileKey: string): string {
  const marker = 'node_modules/';
  return lockfileKey.slice(lockfileKey.lastIndexOf(marker) + marker.length);
}

describe('allowScripts covers every package npm would otherwise block', () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'),
  ) as { allowScripts?: Record<string, boolean> };

  const lockfile = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'package-lock.json'), 'utf8'),
  ) as { packages: Record<string, LockfileEntry> };

  const installScriptPackages = new Set(
    Object.entries(lockfile.packages)
      .filter(([key, entry]) => key.startsWith('node_modules/') && entry.hasInstallScript === true && !entry.link)
      .map(([key]) => packageNameFor(key)),
  );

  it('the key exists at all', () => {
    expect(
      manifest.allowScripts,
      'package.json has no "allowScripts" key. npm 12 reads it to decide which dependencies may run '
      + 'their install and postinstall scripts. Without it every native dependency installs as an '
      + 'empty shell, `npm ci` still exits 0, and the failure only shows up later as a missing '
      + 'electron binary or an unbuilt better-sqlite3.',
    ).toBeTypeOf('object');
  });

  it('finds install-script packages in the lockfile', () => {
    // Guards against the derivation below silently reducing to zero cases if npm ever
    // stops writing `hasInstallScript`, which would make the real check pass vacuously.
    expect(installScriptPackages.size).toBeGreaterThan(0);
    // Named so the guard cannot pass on an empty or unrelated set. Keep this list to
    // packages that compile or download at install time; a package can legitimately
    // leave it by switching to prebuilds, which is what better-sqlite3 13 does
    // (`gypfile: false` plus per-platform exports), so re-check it on that bump
    // rather than assuming the pin is still true.
    for (const name of ['electron', 'better-sqlite3', 'node-pty']) {
      expect(installScriptPackages, `${name} should be one of them`).toContain(name);
    }
  });

  it('covers every package the lockfile says has an install script', () => {
    const allowed = new Set(Object.keys(manifest.allowScripts ?? {}));
    const uncovered = [...installScriptPackages].filter((name) => !allowed.has(name)).sort();

    expect(
      uncovered,
      `${uncovered.join(', ')} declare an install or postinstall script but are not listed in `
      + 'package.json\'s "allowScripts", so npm 12 will block them on a clean install and the '
      + 'package will be unpacked but never built. Add each one, or run '
      + '`npm install-scripts ls` to see what npm is blocking.',
    ).toEqual([]);
  });

  it('every allowScripts entry is a real package, so the list cannot rot', () => {
    // A stale entry is harmless to npm but it is a claim nobody re-checks, and the
    // list is the only record of which native dependencies this project has.
    const installed = new Set(Object.keys(lockfile.packages).map(packageNameFor));
    const stale = Object.keys(manifest.allowScripts ?? {})
      .filter((name) => !installed.has(name))
      .sort();

    expect(
      stale,
      `${stale.join(', ')} are listed in "allowScripts" but are not in the lockfile at all. Either `
      + 'the dependency was removed and the entry should go too, or the name is misspelled, in which '
      + 'case the package it was meant to cover is silently being blocked.',
    ).toEqual([]);
  });
});
