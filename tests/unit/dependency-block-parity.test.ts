/**
 * package.json's `dependencies` block decides what electron-builder copies into the
 * asar. It computes the production dependency tree from that block on its own, and
 * the `files:` whitelist in electron-builder.yml narrows the app's own files rather
 * than restricting node_modules. So an entry in `dependencies` that nothing needs at
 * runtime is not cosmetic: it and its whole transitive closure are copied into every
 * installer.
 *
 * Everything under src/ is bundled. Vite bundles the renderer, esbuild bundles main,
 * preload, and the three utilityProcess workers, and the only packages left out of
 * those bundles are the `external` list in scripts/build.js. So the set of packages
 * that genuinely have to be present as real node_modules directories is small, and
 * derivable: the externals, plus whatever electron-builder.yml names directly.
 *
 * The block had drifted a long way from that. It carried monaco-editor, recharts,
 * react-markdown, turndown, @sentry/electron and nine more, all of them already
 * inside .vite/build/**, which resolved to 302 production packages where 121 were
 * needed. npm's default is to write a new install into `dependencies`, so the drift
 * is the resting state and something has to hold the line.
 *
 * Tier: Unit.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/**
 * `electron` is an esbuild external and it obviously ships, but it is the one
 * external that must NOT be a production dependency. electron-builder resolves the
 * Electron version from `devDependencies` first
 * (app-builder-lib/out/electron/electronVersion.js, findFromPackageMetadata), and a
 * production `electron` would additionally be copied into the asar next to the
 * runtime the packager already places there.
 */
const EXTERNAL_EXEMPT_FROM_DEPENDENCIES = 'electron';

interface PackageManifest {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
}

function readManifest(): PackageManifest {
  const source = fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8');
  const parsed = JSON.parse(source) as Partial<PackageManifest>;
  return {
    dependencies: parsed.dependencies ?? {},
    devDependencies: parsed.devDependencies ?? {},
  };
}

/** The `external:` array shared by scripts/build.js and scripts/dev.js. */
function readEsbuildExternals(): string[] {
  const source = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'build.js'), 'utf8');
  const match = source.match(/external:\s*\[([^\]]*)\]/);
  if (match === null) {
    throw new Error(
      'scripts/build.js: could not find the esbuild `external: [...]` array. This test derives the '
      + 'expected dependencies block from it, so a rename means the derivation needs rewriting '
      + 'rather than silently passing against an empty list.',
    );
  }
  return [...match[1].matchAll(/'([^']+)'/g)].map((quoted) => quoted[1]);
}

/**
 * The package-name patterns electron-builder.yml's `files:` names directly, taken from
 * its `node_modules/<pattern>/**` entries. Exclusion entries (a leading `!`) are
 * skipped: they carve paths out of an already-included package rather than naming one.
 */
function readFilesPackagePatterns(): string[] {
  const source = fs.readFileSync(path.join(REPO_ROOT, 'electron-builder.yml'), 'utf8');
  const match = source.match(/\nfiles:\n([\s\S]*?)\nasar: /);
  if (match === null) {
    throw new Error('electron-builder.yml: could not find the `files:` block ending at `asar: `');
  }
  const patterns = match[1]
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2).trim().replace(/^["']|["']$/g, ''))
    .filter((entry) => entry.startsWith('node_modules/'))
    .map((entry) => entry.slice('node_modules/'.length).replace(/\/\*\*$/, ''));
  if (patterns.length === 0) {
    throw new Error('electron-builder.yml: the `files:` block names no node_modules entries');
  }
  return patterns;
}

/**
 * True when a `files:` pattern names this package. `*` is a wildcard, which covers the
 * per-platform families (sherpa-onnx-*, sqlite-vec-*), and a pattern also covers
 * everything under it, which covers a bare scope (@img covering @img/sharp-win32-x64).
 */
export function filesPatternMatches(pattern: string, packageName: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
  return new RegExp(`^${escaped}(/.*)?$`).test(packageName);
}

describe('package.json dependency block parity', () => {
  const manifest = readManifest();
  const externals = readEsbuildExternals();
  const filesPatterns = readFilesPackagePatterns();

  const isShippedAsNodeModules = (name: string): boolean =>
    externals.includes(name) || filesPatterns.some((pattern) => filesPatternMatches(pattern, name));

  it('reads a non-empty externals list and files: block', () => {
    // Both derivations are regexes over files this repo edits often. If either returns
    // nothing, the checks below pass vacuously, which is how a guard gets disabled
    // without anyone noticing.
    expect(externals.length).toBeGreaterThan(0);
    expect(externals).toContain(EXTERNAL_EXEMPT_FROM_DEPENDENCIES);
    expect(filesPatterns.length).toBeGreaterThan(0);
    expect(Object.keys(manifest.dependencies).length).toBeGreaterThan(0);
  });

  it('every dependencies entry is an esbuild external or is named by electron-builder.yml files:', () => {
    const offenders = Object.keys(manifest.dependencies).filter((name) => !isShippedAsNodeModules(name));

    expect(
      offenders,
      `${offenders.join(', ')} sit in "dependencies" but nothing ships them as node_modules. They are `
      + 'neither in the esbuild `external` list (scripts/build.js) nor named by a '
      + '`node_modules/<name>/**` glob in the `files:` block of electron-builder.yml. Everything else '
      + 'under src/ is bundled into .vite/build/**, so a production entry here copies the package and '
      + 'its whole transitive closure into every installer for nothing. Move it to devDependencies.',
    ).toEqual([]);
  });

  it('every esbuild external except electron is a dependencies entry', () => {
    const missing = externals
      .filter((name) => name !== EXTERNAL_EXEMPT_FROM_DEPENDENCIES)
      .filter((name) => manifest.dependencies[name] === undefined);

    expect(
      missing,
      `${missing.join(', ')} are esbuild externals, so esbuild leaves them out of the bundle and the `
      + 'packaged app resolves them from node_modules at runtime. They must be in "dependencies", or '
      + 'electron-builder will not copy them into the asar and the app fails at module load.',
    ).toEqual([]);
  });

  it('electron stays in devDependencies', () => {
    expect(
      manifest.dependencies[EXTERNAL_EXEMPT_FROM_DEPENDENCIES],
      'electron is an esbuild external, but it is the one external that must stay in '
      + 'devDependencies. electron-builder reads the Electron version from devDependencies first '
      + '(app-builder-lib/out/electron/electronVersion.js), and a production entry would also copy '
      + 'the whole electron npm package into the asar alongside the runtime the packager already '
      + 'ships.',
    ).toBeUndefined();
    expect(manifest.devDependencies[EXTERNAL_EXEMPT_FROM_DEPENDENCIES]).toBeTypeOf('string');
  });

  it('no package is declared in both blocks', () => {
    const both = Object.keys(manifest.dependencies)
      .filter((name) => manifest.devDependencies[name] !== undefined);
    expect(both, `${both.join(', ')} appear in both dependencies and devDependencies`).toEqual([]);
  });

  it('matches a files: pattern the way electron-builder does', () => {
    // Red-green proof for the matcher, so a regex slip cannot quietly make every
    // package "covered" (which would pass the first check against anything) or
    // "uncovered" (which would fail it against a healthy manifest).
    expect(filesPatternMatches('better-sqlite3', 'better-sqlite3')).toBe(true);
    expect(filesPatternMatches('better-sqlite3', 'better-sqlite3-extra')).toBe(false);
    expect(filesPatternMatches('sherpa-onnx-*', 'sherpa-onnx-win-x64')).toBe(true);
    expect(filesPatternMatches('sherpa-onnx-*', 'sherpa-onnx')).toBe(false);
    expect(filesPatternMatches('@huggingface/transformers', '@huggingface/transformers')).toBe(true);
    expect(filesPatternMatches('@huggingface/transformers', '@huggingface/tokenizers')).toBe(false);
    expect(filesPatternMatches('@img', '@img/sharp-win32-x64')).toBe(true);
    expect(filesPatternMatches('@img', '@imgx/other')).toBe(false);
    expect(filesPatternMatches('sqlite-vec-*', 'sqlite-vec-windows-x64')).toBe(true);
  });

  it('detects a package that belongs in devDependencies', () => {
    // Drives the detector over known-bad input, so an `isShippedAsNodeModules` that
    // starts returning true for everything is caught rather than passing silently.
    expect(isShippedAsNodeModules('monaco-editor')).toBe(false);
    expect(isShippedAsNodeModules('recharts')).toBe(false);
    expect(isShippedAsNodeModules('@sentry/electron')).toBe(false);
    expect(isShippedAsNodeModules('better-sqlite3')).toBe(true);
    expect(isShippedAsNodeModules('bindings')).toBe(true);
  });
});
