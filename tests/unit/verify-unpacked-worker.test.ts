/**
 * build/verify-unpacked-worker.js - the afterPack gate that loads the embed
 * worker's externals from the app.asar.unpacked tree electron-builder just
 * produced, with plain Node, fenced to that tree.
 *
 * The bug it exists for (DESKTOP-H): the packaged worker is forked from the
 * unpacked tree, so it resolves `@huggingface/transformers` and everything
 * that package requires by plain directory resolution. `onnxruntime-common`
 * and `sharp` shipped inside the asar only, so every packaged install's
 * worker died at module load with `Cannot find module`, on every fork, and
 * nothing in the build had ever tried the load.
 *
 * The CJS script is imported through `createRequire`, the way
 * tests/unit/upload-native-debug-files.test.ts imports scripts/build.js: a
 * plain CJS module's own `require` resolves through Node's cache, not vitest's
 * mock registry, so the spawn is injected as a parameter instead of mocked.
 *
 * Tier: Unit.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const {
  verifyUnpackedWorkerModules,
  buildProbeScript,
  EMBED_WORKER_EXTERNALS,
  EMBED_WORKER_PROBE_DEPENDENCIES,
} = require('../../build/verify-unpacked-worker.js');

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const MOCK_ROOT = path.join(path.sep, 'mock', 'app.asar.unpacked');

interface SpawnError extends Error {
  stderr?: string;
}

describe('verifyUnpackedWorkerModules (injected spawn)', () => {
  it('throws with the child stderr when a module fails to load, naming the module and the root', () => {
    const spawn = vi.fn(() => {
      const error: SpawnError = new Error('Command failed');
      error.stderr = "Error: Cannot find module 'onnxruntime-common'\nRequire stack:\n- ~/x.js\n";
      throw error;
    });
    expect(() =>
      verifyUnpackedWorkerModules({
        unpackedRoot: MOCK_ROOT,
        moduleNames: ['@huggingface/transformers'],
        spawn,
        log: vi.fn(),
      }),
    ).toThrow(/@huggingface\/transformers does not load from the unpacked tree at [\s\S]*Cannot find module 'onnxruntime-common'/);
  });

  it('logs the verified branch and each resolved dependency on success', () => {
    const resolvedLine = `sharp -> ${path.join(MOCK_ROOT, 'node_modules', 'sharp', 'lib', 'index.js')}`;
    const spawn = vi.fn(() => `${resolvedLine}\n`);
    const log = vi.fn();
    verifyUnpackedWorkerModules({
      unpackedRoot: MOCK_ROOT,
      moduleNames: ['@huggingface/transformers'],
      spawn,
      log,
    });
    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      ['-e', expect.stringContaining('@huggingface/transformers')],
      expect.objectContaining({ encoding: 'utf8', timeout: 60_000 }),
    );
    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(/^\[afterPack\] @huggingface\/transformers loads from the unpacked tree \(node v/),
    );
    expect(log).toHaveBeenCalledWith(`[afterPack]   ${resolvedLine}`);
  });

  it('defaults to the embed worker externals and probe dependencies', () => {
    const spawn = vi.fn(() => '');
    verifyUnpackedWorkerModules({ unpackedRoot: MOCK_ROOT, spawn, log: vi.fn() });
    expect(spawn).toHaveBeenCalledTimes(EMBED_WORKER_EXTERNALS.length);
    const [, [, script]] = spawn.mock.calls[0] as unknown as [string, [string, string]];
    for (const dependency of EMBED_WORKER_PROBE_DEPENDENCIES) expect(script).toContain(dependency);
  });

  it('builds a probe script that fences resolution to the unpacked root and drops the global lookup paths', () => {
    const script = buildProbeScript(MOCK_ROOT, 'pkg', ['dep']);
    expect(script).toContain('Module._nodeModulePaths = ');
    expect(script).toContain('candidate.startsWith(root)');
    expect(script).toContain('Module.globalPaths = [];');
    expect(script).toContain(JSON.stringify(MOCK_ROOT));
    expect(script).toContain(JSON.stringify('pkg'));
  });
});

describe('verifyUnpackedWorkerModules (real node child)', () => {
  let sandbox: string | null = null;

  afterEach(() => {
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
    sandbox = null;
  });

  function writePackage(root: string, name: string, indexSource: string): void {
    const directory = path.join(root, 'node_modules', name);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      path.join(directory, 'package.json'),
      JSON.stringify({ name, version: '1.0.0', main: 'index.js' }),
    );
    fs.writeFileSync(path.join(directory, 'index.js'), indexSource);
  }

  it('fails while a dependency exists only OUTSIDE the unpacked root (the repo node_modules false pass), and passes once it is inside', () => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-unpacked-gate-'));
    const unpackedRoot = path.join(sandbox, 'out', 'resources', 'app.asar.unpacked');
    writePackage(unpackedRoot, 'fake-worker-external', "module.exports = require('fake-transitive-dep');");
    // Where an unfenced upward walk from the unpacked tree would find it: a
    // node_modules above the root, exactly like the repo's own during a
    // local `npm run package`.
    writePackage(path.join(sandbox, 'out'), 'fake-transitive-dep', 'module.exports = 1;');

    expect(() =>
      verifyUnpackedWorkerModules({
        unpackedRoot,
        moduleNames: ['fake-worker-external'],
        probeDependencies: [],
        log: vi.fn(),
      }),
    ).toThrow(/Cannot find module 'fake-transitive-dep'/);

    writePackage(unpackedRoot, 'fake-transitive-dep', 'module.exports = 1;');
    const log = vi.fn();
    verifyUnpackedWorkerModules({
      unpackedRoot,
      moduleNames: ['fake-worker-external'],
      probeDependencies: ['fake-transitive-dep'],
      log,
    });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('fake-worker-external loads from the unpacked tree'));
    const realUnpackedRoot = fs.realpathSync(unpackedRoot);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining(path.join(realUnpackedRoot, 'node_modules', 'fake-transitive-dep', 'index.js')),
    );
  }, 30_000);
});

/** Pulls the `- "..."` (or `- ...`) entries out of a YAML list section, in
 *  order, with surrounding quotes stripped. Comment lines and sub-key entries
 *  (`- from: ...`) that don't start with a dash are ignored by the caller's
 *  section boundaries, not here. */
function parseYamlListEntries(section: string): string[] {
  return section
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2).trim())
    .map((entry) => entry.replace(/^["']|["']$/g, ''));
}

/** True when `filesEntries` actually places `asarUnpackEntry` inside the
 *  asar, either via a literal match or a broader glob that covers it (e.g.
 *  `.vite/build/**` covers `.vite/build/embed-worker.js`; `node_modules/foo/**`
 *  covers `node_modules/foo/prebuilds/**`). Mirrors electron-builder's own
 *  glob semantics closely enough for this parity check: a `**` entry matches
 *  every path under its directory. */
function isCoveredByFiles(asarUnpackEntry: string, filesEntries: string[]): boolean {
  if (filesEntries.includes(asarUnpackEntry)) return true;
  return filesEntries.some((filesEntry) => {
    if (!filesEntry.endsWith('/**')) return false;
    const directory = filesEntry.slice(0, -'/**'.length);
    return asarUnpackEntry.startsWith(`${directory}/`);
  });
}

describe('embed worker closure parity', () => {
  it('EMBED_WORKER_EXTERNALS is exactly the set of bare imports in embed-worker.ts, and every one is an esbuild external', () => {
    const workerSource = fs.readFileSync(
      path.join(REPO_ROOT, 'src', 'main', 'retrieval', 'embedder', 'embed-worker.ts'),
      'utf8',
    );
    const bareImports = [...workerSource.matchAll(/from\s+'([^'.][^']*)'/g)]
      .map((match) => match[1])
      .filter((specifier) => !specifier.startsWith('node:'));
    expect(new Set(bareImports)).toEqual(new Set(EMBED_WORKER_EXTERNALS));

    const buildSource = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'build.js'), 'utf8');
    const externalMatch = buildSource.match(/external:\s*\[([^\]]*)\]/);
    expect(externalMatch).not.toBeNull();
    const externals = [...(externalMatch?.[1] ?? '').matchAll(/'([^']+)'/g)].map((match) => match[1]);
    for (const name of EMBED_WORKER_EXTERNALS) expect(externals).toContain(name);
  });

  it('every probed dependency, and the rest of the runtime closure, is unpacked by electron-builder.yml', () => {
    const config = fs.readFileSync(path.join(REPO_ROOT, 'electron-builder.yml'), 'utf8');
    const asarUnpackStart = config.indexOf('asarUnpack:');
    const asarUnpackEnd = config.indexOf('extraResources:');
    expect(asarUnpackStart).toBeGreaterThan(-1);
    expect(asarUnpackEnd).toBeGreaterThan(asarUnpackStart);
    const asarUnpack = config.slice(asarUnpackStart, asarUnpackEnd);
    for (const name of [...EMBED_WORKER_PROBE_DEPENDENCIES, 'detect-libc', 'semver']) {
      expect(asarUnpack).toContain(`"node_modules/${name}/**"`);
    }
    expect(asarUnpack).toContain('"node_modules/@img/**"');
    expect(asarUnpack).toContain('"node_modules/@huggingface/transformers/**"');
  });

  it('every asarUnpack entry is actually placed in the asar by files: - unpacking a package that was never packed ships nothing', () => {
    // asarUnpack alone is not enough: a package listed there but missing from
    // `files:` is never copied into the asar in the first place, so there is
    // nothing for electron-builder to unpack and the packaged worker dies at
    // module load exactly like the pre-fix 0.38.0/0.39.0 build (DESKTOP-6,
    // DESKTOP-H). This asserts the real invariant - every asarUnpack entry is
    // covered by a files: entry - rather than hardcoding the five package
    // names, so it also guards node-pty's prebuilds/** (covered by the
    // broader node_modules/node-pty/** in files) and the .vite/build/*.js
    // worker bundles (covered by .vite/build/**) without special-casing them.
    const config = fs.readFileSync(path.join(REPO_ROOT, 'electron-builder.yml'), 'utf8');
    const filesMatch = config.match(/\nfiles:\n([\s\S]*?)\nasar: /);
    const asarUnpackMatch = config.match(/\nasarUnpack:\n([\s\S]*?)\nextraResources:/);
    expect(filesMatch).not.toBeNull();
    expect(asarUnpackMatch).not.toBeNull();

    const filesEntries = parseYamlListEntries(filesMatch?.[1] ?? '').filter((entry) => !entry.startsWith('!'));
    const asarUnpackEntries = parseYamlListEntries(asarUnpackMatch?.[1] ?? '');
    expect(filesEntries.length).toBeGreaterThan(0);
    expect(asarUnpackEntries.length).toBeGreaterThan(0);

    for (const asarUnpackEntry of asarUnpackEntries) {
      expect(
        isCoveredByFiles(asarUnpackEntry, filesEntries),
        `asarUnpack lists "${asarUnpackEntry}" but no files: entry copies it into the asar, so there is nothing to unpack`,
      ).toBe(true);
    }

    // The specific closure this change exists to protect: onnxruntime-common
    // and sharp shipped in the asar only (not unpacked) in 0.38.0/0.39.0, and
    // sharp's own runtime deps (@img/*, detect-libc, semver) have the same
    // requirement. Assert them by name too, so a future drift in the general
    // check's glob-coverage logic doesn't silently stop protecting the exact
    // packages this test was written for.
    for (const name of ['onnxruntime-common', 'sharp', 'detect-libc', 'semver']) {
      expect(filesEntries).toContain(`node_modules/${name}/**`);
    }
    expect(filesEntries).toContain('node_modules/@img/**');
  });
});
