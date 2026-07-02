/**
 * Renderer optimizeDeps parity guard.
 *
 * scripts/renderer-optimize-deps.json is the single list of renderer deps that
 * Vite pre-bundles at dev-server boot. It is consumed by BOTH vite.config.mts
 * and the inline worktree config in scripts/dev.js (which cannot load
 * vite.config.mts). Two invariants keep the dogfooded `npm start` app healthy:
 *
 * 1. DEEP imports of pre-bundled packages must be pre-bundled too. A dep
 *    specifier Vite first meets after boot (reachable only behind a React.lazy
 *    island, e.g. the Changes panel's monaco graph) can trigger a mid-session
 *    re-optimization. Combined with the shared-cache clobbering fixed via the
 *    worktree cacheDir (scripts/dev.js), this surfaced as "Failed to fetch
 *    dynamically imported module" on the Changes panel, a failure the browser
 *    then caches in the module map for the document lifetime.
 *
 * 2. @monaco-editor/react must NEVER be pre-bundled (commit 5bb2e089):
 *    pre-bundling wraps it in Vite's CJS-ESM interop, handing it a React copy
 *    whose hooks dispatcher is null (useState-on-null crash in DiffEditor on
 *    React 19). Served un-bundled as native ESM, its react imports are
 *    rewritten to the shared pre-bundled react and hooks work. JSON cannot
 *    carry comments, so this test is where that constraint lives.
 *
 * Plus mechanical guards that worktree-started Vite servers keep their dep
 * caches out of the junction-shared node_modules (the clobbering root cause).
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../..');
const OPTIMIZE_DEPS_JSON = path.join(REPO_ROOT, 'scripts', 'renderer-optimize-deps.json');
// Everything Vite serves to the renderer in dev: the renderer itself plus the
// dev-only devtools renderer surface imported from App.tsx / DeveloperTab.
const SCAN_ROOTS = [
  path.join(REPO_ROOT, 'src', 'renderer'),
  path.join(REPO_ROOT, 'src', 'devtools', 'renderer'),
];
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);

// Specifiers the dep optimizer never handles:
// - Vite query imports (?worker, ?url, ?raw) go through dedicated plugins.
// - CSS/asset deep imports go through the CSS/asset pipeline.
// - Relative, alias, and node builtin specifiers are not node_modules deps.
const ASSET_EXTENSION = /\.(css|scss|sass|less|styl|svg|png|jpe?g|gif|webp|woff2?)$/i;

function isOptimizerCandidate(specifier: string): boolean {
  if (specifier.includes('?')) return false;
  if (specifier.startsWith('.') || specifier.startsWith('/')) return false;
  if (specifier.startsWith('@shared/')) return false; // resolve.alias, not a package
  if (specifier.startsWith('node:')) return false;
  if (ASSET_EXTENSION.test(specifier)) return false;
  return true;
}

// '@dnd-kit/core' is a package NAME (scoped packages span two segments);
// 'monaco-editor/esm/vs/base/common/errors' is a deep subpath of 'monaco-editor'.
function packageNameOf(specifier: string): string {
  const segments = specifier.split('/');
  return specifier.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0];
}

function collectSourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(fullPath));
    } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(fullPath);
    }
  }
  return files;
}

function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

// Static imports and re-exports, dynamic import() with a string literal, and
// side-effect imports. Multi-line import statements keep their from-clause on
// one line, so line-based scanning (which lets us skip comment lines, the same
// approach as external-scripts-parity.test.ts) sees every specifier.
const SPECIFIER_PATTERNS: RegExp[] = [
  /\bfrom\s*(['"])([^'"]+)\1/g,
  /\bimport\s*\(\s*(['"])([^'"]+)\1/g,
  /^\s*import\s+(['"])([^'"]+)\1/g,
];

type FoundSpecifier = { specifier: string; location: string };

function collectBareSpecifiers(): FoundSpecifier[] {
  const found: FoundSpecifier[] = [];
  for (const root of SCAN_ROOTS) {
    if (!fs.existsSync(root)) continue;
    for (const filePath of collectSourceFiles(root)) {
      const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
      lines.forEach((line, index) => {
        if (isCommentLine(line)) return;
        for (const pattern of SPECIFIER_PATTERNS) {
          for (const match of line.matchAll(pattern)) {
            const specifier = match[2];
            if (!isOptimizerCandidate(specifier)) continue;
            found.push({
              specifier,
              location: `${path.relative(REPO_ROOT, filePath).replace(/\\/g, '/')}:${index + 1}`,
            });
          }
        }
      });
    }
  }
  return found;
}

const includeList = JSON.parse(fs.readFileSync(OPTIMIZE_DEPS_JSON, 'utf-8')) as unknown;

describe('renderer optimizeDeps parity', () => {
  it('renderer-optimize-deps.json is a string array of installed packages', () => {
    expect(Array.isArray(includeList)).toBe(true);
    for (const entry of includeList as unknown[]) {
      expect(typeof entry, `non-string entry: ${JSON.stringify(entry)}`).toBe('string');
      const packageName = packageNameOf(entry as string);
      expect(
        fs.existsSync(path.join(REPO_ROOT, 'node_modules', packageName)),
        `entry '${String(entry)}' references package '${packageName}', which is not installed`,
      ).toBe(true);
    }
  });

  it('every deep import of a pre-bundled package is itself pre-bundled', () => {
    const entries = includeList as string[];
    const includeSet = new Set(entries);
    const listedPackages = new Set(entries.map(packageNameOf));
    const violations: string[] = [];
    for (const { specifier, location } of collectBareSpecifiers()) {
      const packageName = packageNameOf(specifier);
      if (specifier === packageName) continue; // package root; the boot scan handles it
      if (!listedPackages.has(packageName)) continue; // family not force-included
      if (includeSet.has(specifier)) continue;
      violations.push(`${location} -> '${specifier}'`);
    }
    expect(
      violations,
      `Deep imports of pre-bundled packages must be listed in `
        + `scripts/renderer-optimize-deps.json, or Vite can meet them after boot and `
        + `re-bundle mid-session (the Changes panel "Failed to fetch dynamically `
        + `imported module" bug). Add these specifiers to the JSON:\n${violations.join('\n')}`,
    ).toEqual([]);
  });

  it('never pre-bundles @monaco-editor/react (React 19 useState crash, commit 5bb2e089)', () => {
    // Pre-bundling wraps @monaco-editor/react in Vite's CJS-ESM interop and
    // hands it a React copy whose hooks dispatcher is null, crashing
    // DiffEditor's useState. Served un-bundled as native ESM, its react
    // imports rewrite to the shared pre-bundled react. Do NOT re-add it.
    expect((includeList as string[]).includes('@monaco-editor/react')).toBe(false);
  });
});

describe('worktree vite cache isolation', () => {
  // The worktree's node_modules is a junction to the main repo's
  // (src/main/git/node-modules-link.ts), so a worktree dev server using the
  // default cacheDir (<root>/node_modules/.vite) physically shares, and with a
  // differently-resolved config clobbers, the running main server's dep cache.
  // Do not delete these assertions to silence a refactor; move the cacheDir
  // and update the patterns instead.
  it('scripts/dev.js gives worktree servers a cacheDir outside node_modules', () => {
    const source = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'dev.js'), 'utf-8');
    expect(
      /cacheDir:\s*viteCacheDir/.test(source),
      'scripts/dev.js worktree createServer config must set cacheDir: viteCacheDir',
    ).toBe(true);
    expect(
      /['"]\.kangentic['"],\s*['"]vite-cache['"]/.test(source),
      'scripts/dev.js must place the worktree vite cache at <worktree>/.kangentic/vite-cache',
    ).toBe(true);
  });

  it('vite.config.mts isolates worktree-started servers (Playwright webServer) the same way', () => {
    const source = fs.readFileSync(path.join(REPO_ROOT, 'vite.config.mts'), 'utf-8');
    expect(
      /cacheDir:\s*path\.join\(configDir,\s*['"]\.kangentic['"],\s*['"]vite-cache-tests['"]\)/.test(source),
      'vite.config.mts must set a worktree-conditional cacheDir '
        + '(.kangentic/vite-cache-tests) so a Playwright-started server in a worktree '
        + 'never rewrites the main checkout node_modules/.vite',
    ).toBe(true);
  });
});
