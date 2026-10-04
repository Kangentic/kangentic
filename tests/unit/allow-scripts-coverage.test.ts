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
 * still exits 0, but node-pty is never built, esbuild never fetches its platform
 * binary, and onnxruntime-node never fetches its native providers. The install looks
 * clean and the tree is unusable.
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
  ) as { allowScripts?: Record<string, boolean>; scripts?: Record<string, string> };

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
      + 'empty shell, `npm ci` still exits 0, and the failure only shows up later as an '
      + 'unbuilt node-pty or a missing esbuild binary.',
    ).toBeTypeOf('object');
  });

  it('finds install-script packages in the lockfile', () => {
    // Guards against the derivation below silently reducing to zero cases if npm ever
    // stops writing `hasInstallScript`, which would make the real check pass vacuously.
    expect(installScriptPackages.size).toBeGreaterThan(0);
    // Named so the guard cannot pass on an empty or unrelated set. Keep this list to
    // packages that compile or download at install time; a package can legitimately
    // leave it. Two already have: better-sqlite3 13 ships its prebuilds in the package
    // (`gypfile: false`, no install script), and electron 42+ downloads its binary on
    // first use instead of in postinstall (the root package's own postinstall runs
    // `install-electron` for it). Re-check this list on any such bump.
    for (const name of ['node-pty', 'esbuild', 'onnxruntime-node']) {
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

  it('covers packages npm gives an implied node-gyp install script, which the lockfile does not record', () => {
    // npm infers `install: node-gyp rebuild` for a package that ships a binding.gyp
    // and declares no install or preinstall script, and npm 12 checks that implied
    // script against allowScripts at install time. It does so even when the package
    // sets `gypfile: false` and the lockfile records no `hasInstallScript`, so the
    // derivation above never sees it. better-sqlite3 13 is that case: its prebuilds
    // ship in the package, so it is denied (`false`) rather than allowed, because
    // `node-gyp rebuild` would demand Python and a C++ toolchain to configure a build
    // that has nothing to compile. Uncovered, every `npm ci` warns that it blocked it.
    const impliedGypPackages = Object.entries(lockfile.packages)
      .filter(([key, entry]) => key.startsWith('node_modules/') && !entry.link)
      .filter(([key]) => fs.existsSync(path.join(REPO_ROOT, key, 'binding.gyp')))
      .filter(([key]) => {
        const installed = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, key, 'package.json'), 'utf8')) as {
          scripts?: Record<string, string>;
        };
        return installed.scripts?.install === undefined && installed.scripts?.preinstall === undefined;
      })
      .map(([key]) => packageNameFor(key));

    // Guards against a vacuous pass: better-sqlite3 is the known member today.
    expect(impliedGypPackages).toContain('better-sqlite3');
    const uncovered = impliedGypPackages.filter((name) => manifest.allowScripts?.[name] === undefined).sort();
    expect(
      uncovered,
      `${uncovered.join(', ')} ship a binding.gyp with no install script, so npm 12 infers \`node-gyp rebuild\` `
      + 'and blocks it unless "allowScripts" decides. Run `npm install-scripts deny <pkg>` when the package '
      + 'ships prebuilds, or `approve` when it really has to compile.',
    ).toEqual([]);
    expect(manifest.allowScripts?.['better-sqlite3'], 'better-sqlite3 ships prebuilds; its implied compile stays denied').toBe(false);
  });

  it('can leave electron out of allowScripts only because the root postinstall and dev.js fetch its binary', () => {
    // electron 42+ no longer downloads its binary in its own postinstall, which is
    // why `electron` is not in allowScripts. That is safe only while two other
    // mechanisms hold, and nothing else asserts either:
    //   1. the root `postinstall` runs `install-electron` (a bin of the electron
    //      package), which fetches the binary on an ordinary install;
    //   2. scripts/dev.js on Windows resolves the executable by requiring the
    //      electron package, which returns the binary path and downloads it on
    //      first use, so an install that skipped scripts still launches.
    expect(
      manifest.scripts?.postinstall,
      'package.json "scripts.postinstall" must be exactly "install-electron". electron 42+ no longer '
      + 'downloads its binary in its own postinstall, so it is not in "allowScripts" and this root '
      + 'script is what fetches the binary on npm ci. Without it a fresh install leaves no Electron '
      + 'binary until something first requires the package.',
    ).toBe('install-electron');

    // Comment-only lines are dropped first, so prose that names the call (like the
    // note above the assignment in dev.js) cannot satisfy the scan.
    const devScriptCode = fs
      .readFileSync(path.join(REPO_ROOT, 'scripts', 'dev.js'), 'utf8')
      .split('\n')
      .filter((line) => {
        const trimmed = line.trim();
        return !(trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*'));
      })
      .join('\n');

    // `const electronExe = process.platform === 'win32' ? <win32 branch> : <posix branch>;`
    // The win32 branch holds no `:` or `;`, so it is everything up to the ternary's colon.
    const electronExeAssignment = /const electronExe\s*=\s*process\.platform\s*===\s*'win32'\s*\?([^:;]+):/.exec(
      devScriptCode,
    );
    expect(
      electronExeAssignment,
      'scripts/dev.js no longer assigns electronExe as `process.platform === \'win32\' ? <win32> : <posix>`. '
      + 'If that shape changed on purpose, update this test, but keep the win32 branch resolving the '
      + 'binary through require() of the electron package so a first run can download it.',
    ).not.toBeNull();
    const win32Branch = (electronExeAssignment?.[1] ?? '').trim();

    expect(
      win32Branch,
      'The win32 branch of electronExe must be require(path.join(projectDir, \'node_modules\', \'electron\')). '
      + 'Requiring the electron package returns the binary path and downloads the binary when it is missing. '
      + 'Any other form leaves `npm start` on Windows failing with ENOENT after `npm ci --ignore-scripts` or a '
      + 'failed postinstall, because electron 42+ does not download its binary at install time.',
    ).toMatch(/^require\(\s*path\.join\(\s*projectDir\s*,\s*['"]node_modules['"]\s*,\s*['"]electron['"]\s*\)\s*\)$/);

    // Compared as the list of offending lines, so a failure prints the line instead of the whole script.
    const distExecutableLines = devScriptCode
      .split('\n')
      .filter((line) => /['"]dist['"]\s*,\s*['"]electron\.exe['"]|dist[\\/]+electron\.exe/.test(line));
    expect(
      distExecutableLines,
      'No code line in scripts/dev.js may build a path to dist/electron.exe. A hard-coded path never triggers '
      + 'the download, so an install that skipped scripts or failed its postinstall has no Electron binary at '
      + 'that path and the dev server cannot launch it.',
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
