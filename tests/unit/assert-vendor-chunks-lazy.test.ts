/**
 * Unit coverage for `assertVendorChunksLazy` in scripts/build.js - the
 * build-time backstop that fails `npm run build` unless the recharts and
 * monaco vendor bundles stayed OUT of the renderer entry's static import
 * closure (see the function's own doc comment for the three invariants).
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
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// scripts/build.js is CJS (a build script, not bundled src - the
// esbuild-cjs-imports rule scopes to src/, not scripts/); vite-node's
// require/import interop lets this named export come through a plain ES
// import, mirroring tests/unit/external-scripts-parity.test.ts importing
// scripts/copy-external-scripts.js the same way.
import { assertVendorChunksLazy } from '../../scripts/build.js';

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
    writeAsset('chunk-with-monaco.js', 'some code ... editorViewZones ... more code\n');
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
    writeAsset('recharts-xyz789.js');
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
    // No .vite/manifest.json written at all.
    writeIndexHtml('<html><body><script type="module" src="./assets/recharts-xyz789.js"></script></body></html>');

    expect(() => assertVendorChunksLazy(tempDir)).toThrow(/index\.html references/);
  });

  it('(f) does not throw on a clean split: recharts and monaco both unreachable from the entry', () => {
    writeAsset('entry-abc123.js', 'plain entry code, no vendor markers\n');
    // recharts chunk exists but the entry does not statically import it.
    writeAsset('recharts-xyz789.js');
    // A monaco-bearing chunk exists (proves the marker scan is not blind)
    // but is likewise not in the entry's static closure - only reachable via
    // a dynamic import, exactly the shape a correctly lazy-split build
    // produces.
    writeAsset('chunk-with-monaco.js', 'some code ... editorViewZones ... more code\n');
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
});
