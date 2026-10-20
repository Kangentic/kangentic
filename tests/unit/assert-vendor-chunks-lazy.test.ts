/**
 * Unit coverage for `assertVendorChunksLazy` in scripts/build.js - the
 * build-time backstop that fails `npm run build` unless the recharts, three,
 * xyflow and monaco vendor bundles and lucide's whole icon map stayed OUT of the
 * renderer entry's static import closure (see the function's own doc comment for
 * the three invariants).
 *
 * Before this file, the function had zero test coverage: it ran only as a
 * side effect of a real `npm run build`, which takes minutes and is not
 * something a unit test should trigger. `scripts/build.js` now guards its
 * auto-run behind `require.main === module` (so `node scripts/build.js` /
 * `npm run build` behave exactly as before) and exports
 * `assertVendorChunksLazy` for direct unit testing - see the `require.main`
 * check at the bottom of scripts/build.js.
 *
 * Each test builds a throwaway renderer-output-shaped directory under
 * `os.tmpdir()` (never a hardcoded path - see cross-platform-parity) with
 * hand-written assets/*.js files and a .vite/manifest.json, and drives one
 * branch of the function.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// scripts/build.js is CJS (a build script, not bundled src - the
// esbuild-cjs-imports rule scopes to src/, not scripts/); vite-node's
// require/import interop lets this named export come through a plain ES
// import, mirroring tests/unit/external-scripts-parity.test.ts importing
// scripts/copy-external-scripts.js the same way.
import { assertVendorChunksLazy } from '../../scripts/build.js';

// build.js pins process.env.NODE_ENV to 'production' at module load, and vitest
// reuses a worker across test files, so that value would otherwise leak into
// every later file in the same worker - remove-worktree.test.ts and
// worktree-manager.ts both branch on NODE_ENV !== 'test'.
//
// vi.hoisted, not a plain top-level const: the static import above is hoisted,
// so a plain const would capture the value build.js had ALREADY overwritten.
// The sibling upload-native-debug-files.test.ts needs no such trick because it
// only ever loads build.js through a dynamic import inside a test.
const ORIGINAL_NODE_ENV = vi.hoisted(() => process.env.NODE_ENV);

afterAll(() => {
  process.env.NODE_ENV = ORIGINAL_NODE_ENV;
});

interface ManifestEntry {
  file: string;
  isEntry?: boolean;
  imports?: string[];
}

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-vendor-chunks-'));
  fs.mkdirSync(path.join(tempDir, 'assets'), { recursive: true });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function writeAsset(fileName: string, content = '// stub asset\n'): void {
  fs.writeFileSync(path.join(tempDir, 'assets', fileName), content);
}

function writeManifest(manifest: Record<string, ManifestEntry>): void {
  fs.mkdirSync(path.join(tempDir, '.vite'), { recursive: true });
  fs.writeFileSync(path.join(tempDir, '.vite', 'manifest.json'), JSON.stringify(manifest, null, 2));
}

function writeIndexHtml(content: string): void {
  fs.writeFileSync(path.join(tempDir, 'index.html'), content);
}

/** The marker scripts/build.js finds lucide's whole icon map by: an icon no renderer file imports by name. */
const ICON_MAP_MARKER = 'ferris-wheel';

/**
 * lucide's whole icon map in its own chunk, named with the marker and reachable only by dynamic import,
 * as a correct build emits it. Every case that has to get past the icon-map checks writes this.
 */
function writeLazyIconCatalog(): void {
  writeAsset('icon-catalog-pqr987.js', `const glyphs = { "${ICON_MAP_MARKER}": 1 };\n`);
}

describe('assertVendorChunksLazy', () => {
  it('(a) throws when no recharts-*.js chunk exists in assets/', () => {
    writeAsset('index-abc123.js');
    // No manifest needed: the recharts-existence check runs before the
    // manifest is ever read.
    expect(() => assertVendorChunksLazy(tempDir)).toThrow(/No recharts-\*\.js chunk/);
  });

  it('(b) throws when the recharts chunk is in the entry\'s STATIC import closure', () => {
    writeAsset('entry-abc123.js');
    writeAsset('recharts-xyz789.js');
    writeManifest({
      'src/renderer/index.tsx': {
        file: 'assets/entry-abc123.js',
        isEntry: true,
        // The entry statically imports the recharts chunk directly - the
        // exact regression this invariant guards against.
        imports: ['recharts-chunk-key'],
      },
      'recharts-chunk-key': {
        file: 'assets/recharts-xyz789.js',
        imports: [],
      },
    });

    expect(() => assertVendorChunksLazy(tempDir)).toThrow(/STATIC import closure/);
    expect(() => assertVendorChunksLazy(tempDir)).toThrow(/recharts-xyz789\.js/);
  });

  it('(c) throws when a statically-reachable chunk contains a monaco marker', () => {
    writeAsset('entry-abc123.js');
    // recharts chunk exists but is NOT referenced by the entry's imports, so
    // step (b) passes and the walk reaches the monaco scan.
    writeAsset('recharts-xyz789.js');
    writeAsset('three-def456.js');
    writeAsset('xyflow-ghi321.js');
    writeAsset('chunk-with-monaco.js', 'some code ... editorViewZones ... more code\n');
    writeLazyIconCatalog();
    writeManifest({
      'src/renderer/index.tsx': {
        file: 'assets/entry-abc123.js',
        isEntry: true,
        imports: ['monaco-chunk-key'],
      },
      'monaco-chunk-key': {
        file: 'assets/chunk-with-monaco.js',
        imports: [],
      },
    });

    expect(() => assertVendorChunksLazy(tempDir)).toThrow(/STATIC import closure but contains monaco/);
  });

  it('(d) throws "gone blind" when no chunk anywhere contains a monaco marker', () => {
    writeAsset('entry-abc123.js', 'plain entry code, no vendor markers\n');
    writeAsset('three-def456.js');
    writeAsset('xyflow-ghi321.js');
    writeAsset('recharts-xyz789.js');
    writeLazyIconCatalog();
    writeManifest({
      'src/renderer/index.tsx': {
        file: 'assets/entry-abc123.js',
        isEntry: true,
        imports: [],
      },
    });

    expect(() => assertVendorChunksLazy(tempDir)).toThrow(/gone blind/);
  });

  it('(e) falls back to the index.html check when the manifest is missing, and throws if it references the recharts chunk', () => {
    writeAsset('recharts-xyz789.js');
    writeAsset('three-def456.js');
    writeAsset('xyflow-ghi321.js');
    // No .vite/manifest.json written at all.
    writeIndexHtml('<html><body><script type="module" src="./assets/recharts-xyz789.js"></script></body></html>');

    expect(() => assertVendorChunksLazy(tempDir)).toThrow(/index\.html references/);
  });

  it('(f) does not throw on a clean split: recharts and monaco both unreachable from the entry', () => {
    writeAsset('entry-abc123.js', 'plain entry code, no vendor markers\n');
    // recharts chunk exists but the entry does not statically import it.
    writeAsset('recharts-xyz789.js');
    writeAsset('three-def456.js');
    writeAsset('xyflow-ghi321.js');
    // A monaco-bearing chunk exists (proves the marker scan is not blind)
    // but is likewise not in the entry's static closure - only reachable via
    // a dynamic import, exactly the shape a correctly lazy-split build
    // produces.
    writeAsset('chunk-with-monaco.js', 'some code ... editorViewZones ... more code\n');
    writeLazyIconCatalog();
    writeManifest({
      'src/renderer/index.tsx': {
        file: 'assets/entry-abc123.js',
        isEntry: true,
        imports: [],
      },
      'monaco-chunk-key': {
        file: 'assets/chunk-with-monaco.js',
        imports: [],
      },
    });

    expect(() => assertVendorChunksLazy(tempDir)).not.toThrow();
  });

  it('(g) throws when no three-*.js chunk exists in assets/', () => {
    // three is the most exposed of the three lazy vendors: PopOutKnowledgeGraphRoot is
    // statically reachable from the entry via the pop-out surface registry, so
    // the ONLY thing keeping three lazy is that it goes through
    // LazyKnowledgeGraph. A missing named chunk means that check cannot run.
    writeAsset('entry-abc123.js');
    writeAsset('recharts-xyz789.js');
    writeManifest({
      'src/renderer/index.tsx': {
        file: 'assets/entry-abc123.js',
        isEntry: true,
        imports: [],
      },
    });

    expect(() => assertVendorChunksLazy(tempDir)).toThrow(/No three-\*\.js chunk/);
  });

  it('(h) throws when the three chunk is in the entry STATIC import closure', () => {
    writeAsset('entry-abc123.js');
    writeAsset('recharts-xyz789.js');
    writeAsset('three-def456.js');
    writeAsset('xyflow-ghi321.js');
    writeManifest({
      'src/renderer/index.tsx': {
        file: 'assets/entry-abc123.js',
        isEntry: true,
        // Reached one hop in, which is the realistic shape: the pop-out surface
        // registry is statically imported, and a root under it imports the
        // scene directly instead of through LazyKnowledgeGraph.
        imports: ['popout-root-key'],
      },
      'popout-root-key': {
        file: 'assets/popout-root.js',
        imports: ['three-chunk-key'],
      },
      'three-chunk-key': {
        file: 'assets/three-def456.js',
        imports: [],
      },
    });

    expect(() => assertVendorChunksLazy(tempDir)).toThrow(/STATIC import closure/);
    expect(() => assertVendorChunksLazy(tempDir)).toThrow(/three-def456\.js/);
    expect(() => assertVendorChunksLazy(tempDir)).toThrow(/LazyKnowledgeGraph/);
  });

  it('(i) throws when no xyflow-*.js chunk exists in assets/', () => {
    // React Flow loads only with the Workflows view; a missing named chunk
    // means it was folded into another one and the check cannot run.
    writeAsset('entry-abc123.js');
    writeAsset('recharts-xyz789.js');
    writeAsset('three-def456.js');
    writeManifest({
      'src/renderer/index.tsx': { file: 'assets/entry-abc123.js', isEntry: true, imports: [] },
    });

    expect(() => assertVendorChunksLazy(tempDir)).toThrow(/No xyflow-\*\.js chunk/);
  });

  it('(j) throws when the xyflow chunk is in the entry STATIC import closure', () => {
    writeAsset('entry-abc123.js');
    writeAsset('recharts-xyz789.js');
    writeAsset('three-def456.js');
    writeAsset('xyflow-ghi321.js');
    writeManifest({
      'src/renderer/index.tsx': {
        file: 'assets/entry-abc123.js',
        isEntry: true,
        // A startup module that imports the canvas directly instead of
        // through LazyWorkflowsView.
        imports: ['layout-key'],
      },
      'layout-key': { file: 'assets/layout.js', imports: ['xyflow-chunk-key'] },
      'xyflow-chunk-key': { file: 'assets/xyflow-ghi321.js', imports: [] },
    });

    expect(() => assertVendorChunksLazy(tempDir)).toThrow(/xyflow-ghi321\.js is in the entry's STATIC import closure/);
    expect(() => assertVendorChunksLazy(tempDir)).toThrow(/LazyWorkflowsView/);
  });

  it('(k) throws when the xyflow chunk statically imports the recharts chunk', () => {
    // The shape that shipped: a module both use landed in the recharts group,
    // so opening Workflows parsed all of recharts.
    writeAsset('entry-abc123.js');
    writeAsset('recharts-xyz789.js');
    writeAsset('three-def456.js');
    writeAsset('xyflow-ghi321.js');
    writeAsset('chunk-with-monaco.js', 'editorViewZones\n');
    writeManifest({
      'src/renderer/index.tsx': { file: 'assets/entry-abc123.js', isEntry: true, imports: [] },
      'xyflow-chunk-key': { file: 'assets/xyflow-ghi321.js', imports: ['recharts-chunk-key'] },
      'recharts-chunk-key': { file: 'assets/recharts-xyz789.js', imports: [] },
      'monaco-chunk-key': { file: 'assets/chunk-with-monaco.js', imports: [] },
    });

    expect(() => assertVendorChunksLazy(tempDir)).toThrow(/xyflow-ghi321\.js statically imports recharts-xyz789\.js/);
  });

  it('(l) throws when the chart-shared chunk is in the entry STATIC import closure', () => {
    writeAsset('entry-abc123.js');
    writeAsset('recharts-xyz789.js');
    writeAsset('three-def456.js');
    writeAsset('xyflow-ghi321.js');
    writeAsset('chart-shared-mno654.js');
    writeAsset('chunk-with-monaco.js', 'editorViewZones\n');
    writeManifest({
      'src/renderer/index.tsx': { file: 'assets/entry-abc123.js', isEntry: true, imports: ['chart-shared-key'] },
      'chart-shared-key': { file: 'assets/chart-shared-mno654.js', imports: [] },
      'monaco-chunk-key': { file: 'assets/chunk-with-monaco.js', imports: [] },
    });

    expect(() => assertVendorChunksLazy(tempDir)).toThrow(/chart-shared-mno654\.js is in the entry's STATIC import closure/);
  });

  it('(m) does not throw when both lazy views share the chart-shared chunk', () => {
    writeAsset('entry-abc123.js');
    writeAsset('recharts-xyz789.js');
    writeAsset('three-def456.js');
    writeAsset('xyflow-ghi321.js');
    writeAsset('chart-shared-mno654.js');
    writeAsset('chunk-with-monaco.js', 'editorViewZones\n');
    writeLazyIconCatalog();
    writeManifest({
      'src/renderer/index.tsx': { file: 'assets/entry-abc123.js', isEntry: true, imports: [] },
      'xyflow-chunk-key': { file: 'assets/xyflow-ghi321.js', imports: ['chart-shared-key'] },
      'recharts-chunk-key': { file: 'assets/recharts-xyz789.js', imports: ['chart-shared-key'] },
      'chart-shared-key': { file: 'assets/chart-shared-mno654.js', imports: [] },
      'monaco-chunk-key': { file: 'assets/chunk-with-monaco.js', imports: [] },
    });

    expect(() => assertVendorChunksLazy(tempDir)).not.toThrow();
  });

  /** Every vendor chunk a build emits, each lazy, so a case below reaches the icon-map checks. */
  function writeLazyVendorChunks(): void {
    writeAsset('recharts-xyz789.js');
    writeAsset('three-def456.js');
    writeAsset('xyflow-ghi321.js');
    writeAsset('chunk-with-monaco.js', 'editorViewZones\n');
  }

  it('(n) throws when no icon-catalog-*.js chunk exists in assets/', () => {
    writeAsset('entry-abc123.js');
    writeLazyVendorChunks();
    writeManifest({
      'src/renderer/index.tsx': { file: 'assets/entry-abc123.js', isEntry: true, imports: [] },
    });

    expect(() => assertVendorChunksLazy(tempDir)).toThrow(/No icon-catalog-\*\.js chunk/);
  });

  it('(o) throws when the icon-catalog chunk is in the entry STATIC import closure', () => {
    writeAsset('entry-abc123.js');
    writeLazyVendorChunks();
    writeLazyIconCatalog();
    writeManifest({
      'src/renderer/index.tsx': { file: 'assets/entry-abc123.js', isEntry: true, imports: ['board-key'] },
      // A startup module that imports icon-catalog.ts itself instead of through loadIconCatalog().
      'board-key': { file: 'assets/board.js', imports: ['icon-catalog-key'] },
      'icon-catalog-key': { file: 'assets/icon-catalog-pqr987.js', imports: [] },
    });

    expect(() => assertVendorChunksLazy(tempDir)).toThrow(/icon-catalog-pqr987\.js is in the entry's STATIC import closure/);
  });

  it('(p) throws when a statically reachable chunk holds the whole icon map', () => {
    // The shape this guards: something on the startup path imports lucide-react's `icons`, so the
    // map is bundled into a startup chunk while icon-catalog's own chunk stays lazy and passes (o).
    writeAsset('entry-abc123.js', `const glyphs = { "${ICON_MAP_MARKER}": 1 };\n`);
    writeLazyVendorChunks();
    writeLazyIconCatalog();
    writeManifest({
      'src/renderer/index.tsx': { file: 'assets/entry-abc123.js', isEntry: true, imports: [] },
    });

    expect(() => assertVendorChunksLazy(tempDir)).toThrow(/entry-abc123\.js is in the entry's STATIC import closure but holds lucide's whole icon map/);
  });

  it('(q) throws "gone blind" when no chunk anywhere names the icon-map marker', () => {
    writeAsset('entry-abc123.js');
    writeLazyVendorChunks();
    // The catalog chunk exists but no longer carries the marker, as after a lucide rename.
    writeAsset('icon-catalog-pqr987.js', 'const glyphs = { "rocket": 1 };\n');
    writeManifest({
      'src/renderer/index.tsx': { file: 'assets/entry-abc123.js', isEntry: true, imports: [] },
    });

    expect(() => assertVendorChunksLazy(tempDir)).toThrow(new RegExp(`No chunk names the icon "${ICON_MAP_MARKER}"`));
  });
});
