/**
 * Author-time guard for the recharts code-split: walking the renderer entry's
 * STATIC import graph (dynamic `import()` deliberately not followed) must
 * never reach `recharts`. recharts is the largest chart dependency; it is
 * only reachable through the lazy StatsDashboardBody boundary
 * (src/renderer/components/stats/LazyStatsDashboard.tsx), so it parses when
 * the stats surface is opened/warmed, not at cold start competing with the
 * initial board load and session sync.
 *
 * This is the fast unit-tier check that catches a reintroduced static import
 * (e.g. someone importing KngSparkline into the title bar) on every
 * `npm run test:unit`. The ground-truth backstop is `assertVendorChunksLazy`
 * in scripts/build.js, which walks the real Vite manifest of every
 * `npm run build` (also on CI, since the E2E job builds first) and covers
 * monaco the same way.
 *
 * Scanning style mirrors renderer-optimize-deps-parity.test.ts: line-based
 * regex over the from-clause, which the codebase keeps on one line even for
 * multi-line import statements.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../..');
const RENDERER_ENTRY = path.join(REPO_ROOT, 'src', 'renderer', 'index.tsx');
const LAZY_BOUNDARY = path.join(REPO_ROOT, 'src', 'renderer', 'components', 'stats', 'LazyStatsDashboard.tsx');

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx'];

/** Static specifiers only: `import ... from`, `export ... from`, and
 *  side-effect `import '...'`. Dynamic `import('...')` never matches. */
const STATIC_SPECIFIER_PATTERNS: RegExp[] = [
  /\bfrom\s*(['"])([^'"]+)\1/g,
  /^\s*import\s+(['"])([^'"]+)\1/g,
];

function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

/** Type-only imports are erased at build time and pull no runtime code. */
function isTypeOnlyImportLine(line: string): boolean {
  return /^\s*(import|export)\s+type\b/.test(line.trim());
}

function resolveSourceFile(candidateBase: string): string | null {
  for (const extension of SOURCE_EXTENSIONS) {
    if (fs.existsSync(candidateBase + extension)) return candidateBase + extension;
  }
  if (fs.existsSync(candidateBase) && fs.statSync(candidateBase).isFile()) return candidateBase;
  for (const extension of SOURCE_EXTENSIONS) {
    const indexCandidate = path.join(candidateBase, `index${extension}`);
    if (fs.existsSync(indexCandidate)) return indexCandidate;
  }
  return null;
}

/** Resolve a static specifier to a first-party source file, or null for bare
 *  package specifiers / assets (the walk stops at package boundaries; the
 *  only package we assert on is recharts, recorded by the caller). */
function resolveSpecifier(specifier: string, importingFile: string): string | null {
  const withoutQuery = specifier.split('?')[0];
  if (/\.(css|scss|svg|png|jpe?g|gif|webp|woff2?)$/i.test(withoutQuery)) return null;
  if (withoutQuery.startsWith('.')) {
    return resolveSourceFile(path.resolve(path.dirname(importingFile), withoutQuery));
  }
  if (withoutQuery.startsWith('@shared/')) {
    return resolveSourceFile(path.join(REPO_ROOT, 'src', 'shared', withoutQuery.slice('@shared/'.length)));
  }
  if (withoutQuery === '@kangentic/protocol' || withoutQuery.startsWith('@kangentic/protocol/')) {
    const subpath = withoutQuery === '@kangentic/protocol' ? 'index' : withoutQuery.slice('@kangentic/protocol/'.length);
    return resolveSourceFile(path.join(REPO_ROOT, 'packages', 'protocol', 'src', subpath));
  }
  return null; // bare package specifier - not walked
}

interface WalkResult {
  visitedFiles: Set<string>;
  /** file -> line number of the first static recharts import found there. */
  rechartsImports: Map<string, number>;
}

function walkStaticImportGraph(entryFile: string): WalkResult {
  const visitedFiles = new Set<string>();
  const rechartsImports = new Map<string, number>();
  const queue = [entryFile];
  while (queue.length > 0) {
    const currentFile = queue.pop()!;
    if (visitedFiles.has(currentFile)) continue;
    visitedFiles.add(currentFile);
    const lines = fs.readFileSync(currentFile, 'utf-8').split('\n');
    lines.forEach((line, index) => {
      if (isCommentLine(line) || isTypeOnlyImportLine(line)) return;
      for (const pattern of STATIC_SPECIFIER_PATTERNS) {
        for (const match of line.matchAll(pattern)) {
          const specifier = match[2];
          if (specifier === 'recharts' || specifier.startsWith('recharts/')) {
            if (!rechartsImports.has(currentFile)) rechartsImports.set(currentFile, index + 1);
            continue;
          }
          const resolved = resolveSpecifier(specifier, currentFile);
          if (resolved !== null) queue.push(resolved);
        }
      }
    });
  }
  return { visitedFiles, rechartsImports };
}

describe('recharts stays out of the renderer entry static import graph', () => {
  const walk = walkStaticImportGraph(RENDERER_ENTRY);

  it('sanity: the walk actually covers the app (entry, AppLayout, pop-out registry)', () => {
    const relativeVisited = [...walk.visitedFiles].map((file) => path.relative(REPO_ROOT, file).replace(/\\/g, '/'));
    expect(relativeVisited).toContain('src/renderer/index.tsx');
    expect(relativeVisited).toContain('src/renderer/components/layout/AppLayout.tsx');
    // The trap this split exists to cover: the pop-out registry chain is
    // statically reachable from the entry, so its stats root must be lazy too.
    expect(relativeVisited).toContain('src/renderer/pop-out/roots/PopOutStatsRoot.tsx');
    expect(relativeVisited).toContain('src/renderer/components/stats/LazyStatsDashboard.tsx');
    expect(relativeVisited.length).toBeGreaterThan(100);
  });

  it('no statically-reachable module imports recharts', () => {
    const violations = [...walk.rechartsImports.entries()].map(
      ([file, line]) => `${path.relative(REPO_ROOT, file).replace(/\\/g, '/')}:${line}`,
    );
    expect(
      violations,
      'recharts must only be reachable through the lazy StatsDashboardBody boundary '
        + '(LazyStatsDashboard.tsx). A static import chain from the renderer entry now reaches it, '
        + `which puts the whole chart library back into the cold-start bundle:\n${violations.join('\n')}`,
    ).toEqual([]);
  });

  it('the lazy boundary itself still dynamically imports StatsDashboardBody', () => {
    // Guards the boundary against being "simplified" into a static import,
    // which would silently defeat the split while the walk above still passes
    // (StatsDashboardBody would then be visited and flagged - this assertion
    // just fails with a clearer message first).
    const boundarySource = fs.readFileSync(LAZY_BOUNDARY, 'utf-8');
    expect(boundarySource).toMatch(/import\(\s*['"]\.\/StatsDashboardBody['"]\s*\)/);
    expect(boundarySource).not.toMatch(/from\s*['"]\.\/StatsDashboardBody['"]/);
  });

  it('StatsDashboardBody (behind the boundary) is NOT in the static graph, and does reach recharts', () => {
    const statsBody = path.join(REPO_ROOT, 'src', 'renderer', 'components', 'stats', 'StatsDashboardBody.tsx');
    expect(walk.visitedFiles.has(statsBody)).toBe(false);
    // Self-check that this test would actually catch a leak: walking FROM the
    // stats body must find recharts, proving the scanner sees those imports.
    const statsWalk = walkStaticImportGraph(statsBody);
    expect(statsWalk.rechartsImports.size).toBeGreaterThan(0);
  });
});
