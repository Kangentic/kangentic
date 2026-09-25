import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import * as esbuild from 'esbuild';

/**
 * Enforces .claude/rules/dictation-out-of-process.md: sherpa-onnx-node (the
 * dictation engine's native module - DESKTOP-X, a C++ throw inside it during
 * an app quit killed the main process) is imported only by the three engine
 * files that run exclusively inside the `kangentic-dictation` utilityProcess
 * worker, and the worker is constructed only from `dictation-client.ts`.
 * Mirrors tests/unit/central-embedding-engine-boundary.test.ts's scan-and-
 * collect shape, which guards the identical class of boundary for the
 * embedding worker.
 */

const REPO_ROOT = path.resolve(__dirname, '../..');
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);

/** The only files allowed to import sherpa-onnx-node - each runs exclusively
 *  inside the dictation worker (never bundled into main's index.js/preload.js;
 *  see scripts/build.js / scripts/dev.js's dictation-worker.ts entry). The
 *  ambient .d.ts declaration is exempt by construction: it `declare module`s
 *  the package for TypeScript and contains no `from 'sherpa-onnx-node'`
 *  import the regex below would match. */
const SHERPA_IMPORT_ALLOWLIST = new Set([
  'src/main/transcription/engines/sherpa-online-engine.ts',
  'src/main/transcription/engines/sherpa-whisper-engine.ts',
  'src/main/transcription/engines/chunked-offline-engine.ts',
]);

/** The only file allowed to construct a DictationClient. */
const CLIENT_FILE = 'src/main/transcription/dictation-client.ts';

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

function relativeLines(filePath: string): { relPath: string; lines: string[] } {
  const relPath = path.relative(REPO_ROOT, filePath).replace(/\\/g, '/');
  const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
  return { relPath, lines };
}

/** The real esbuild `external` list out of scripts/build.js, text-parsed
 *  (mirrors verify-unpacked-worker.test.ts's convention) rather than
 *  hardcoded a second time, so this test's bundle config can never drift
 *  from the one that actually ships. */
function readEsbuildExternals(): string[] {
  const buildSource = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'build.js'), 'utf-8');
  const match = buildSource.match(/external:\s*\[([^\]]*)\]/);
  return [...(match?.[1] ?? '').matchAll(/'([^']+)'/g)].map((entry) => entry[1]);
}

describe('dictation out-of-process boundary (DESKTOP-X)', () => {
  it('imports sherpa-onnx-node only from the three worker-only engine files', () => {
    const offenders: string[] = [];
    const scanRoot = path.join(REPO_ROOT, 'src/main');
    for (const filePath of collectSourceFiles(scanRoot)) {
      const { relPath, lines } = relativeLines(filePath);
      if (SHERPA_IMPORT_ALLOWLIST.has(relPath)) continue;
      lines.forEach((line, index) => {
        if (/from\s+'sherpa-onnx-node'/.test(line)) {
          offenders.push(`${relPath}:${index + 1}`);
        }
      });
    }
    expect(
      offenders,
      'sherpa-onnx-node must be imported only by the three engine files that run inside the ' +
        'kangentic-dictation utilityProcess worker - importing it anywhere else (including ' +
        'main-resident files like engine-selection.ts or transcription-service.ts) re-links ' +
        'the native addon into the main process bundle and reopens DESKTOP-X. ' +
        `Offenders:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('every allowlisted engine file still actually imports sherpa-onnx-node', () => {
    // The inverse of the check above: if an engine file stopped importing the
    // native module (refactored away, or the import renamed), the allowlist
    // would go stale and silently stop proving anything for that file.
    for (const relPath of SHERPA_IMPORT_ALLOWLIST) {
      const source = fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf-8');
      expect(source, `${relPath} is on the sherpa-onnx-node allowlist but no longer imports it`).toMatch(
        /from\s+'sherpa-onnx-node'/,
      );
    }
  });

  it('constructs DictationClient only from dictation-client.ts', () => {
    const offenders: string[] = [];
    const scanRoot = path.join(REPO_ROOT, 'src/main');
    for (const filePath of collectSourceFiles(scanRoot)) {
      const { relPath, lines } = relativeLines(filePath);
      if (relPath === CLIENT_FILE) continue;
      lines.forEach((line, index) => {
        if (/\bnew DictationClient\s*\(/.test(line)) {
          offenders.push(`${relPath}:${index + 1}`);
        }
      });
    }
    expect(
      offenders,
      'Only dictation-client.ts may construct DictationClient - everything else should import ' +
        `the shared dictationClient singleton (or inject a DictationClient for tests). Offenders:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('the dictation worker entry is registered as its own esbuild bundle in both build.js and dev.js', () => {
    // A dictation-worker.ts pulled into the MAIN bundle (rather than built as
    // its own entry) would defeat the process split even with the import
    // scan above green, since esbuild would inline the whole engine graph -
    // sherpa and all - into index.js.
    for (const scriptName of ['build.js', 'dev.js']) {
      const source = fs.readFileSync(path.join(REPO_ROOT, 'scripts', scriptName), 'utf-8');
      expect(source, `scripts/${scriptName} must build src/main/transcription/dictation-worker.ts as its own entry`).toContain(
        'src/main/transcription/dictation-worker.ts',
      );
      expect(source, `scripts/${scriptName} must output .vite/build/dictation-worker.js`).toContain(
        '.vite/build/dictation-worker.js',
      );
    }
  });

  it('bundling src/main/index.ts with esbuild never pulls sherpa-onnx-node into the shipped main process', async () => {
    // The source scan above catches a DIRECT `from 'sherpa-onnx-node'`
    // outside the allowlist, but not a TRANSITIVE one - a main-resident file
    // importing engine-build.ts, or any engine class, reaches sherpa without
    // ever writing that import string itself, and the scan stays green while
    // DESKTOP-X reopens. This test proves the actual invariant the rule
    // claims - what ends up in the real production bundle - the same way
    // scripts/build.js itself builds it, in-memory (write: false) so it
    // costs no disk I/O.
    const result = await esbuild.build({
      bundle: true,
      platform: 'node',
      target: 'node24',
      format: 'cjs',
      external: readEsbuildExternals(),
      conditions: ['require'],
      define: {
        MAIN_WINDOW_VITE_DEV_SERVER_URL: JSON.stringify(''),
        MAIN_WINDOW_VITE_NAME: JSON.stringify('main_window'),
        __KANGENTIC_DEV__: 'false',
      },
      entryPoints: [path.join(REPO_ROOT, 'src/main/index.ts')],
      write: false,
      logLevel: 'silent',
    });
    const bundleText = result.outputFiles[0].text;
    expect(
      bundleText,
      'src/main/index.ts bundled with sherpa-onnx-node inlined or required - some main-resident ' +
        'file transitively imports one of the three allowlisted engine files (or engine-build.ts, ' +
        'or hybrid-engine.ts). Trace the import chain from index.ts to find it.',
    ).not.toContain('sherpa-onnx-node');
  }, 30_000);
});
