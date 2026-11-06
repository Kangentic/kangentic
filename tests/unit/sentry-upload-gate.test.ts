/**
 * The Sentry upload gate (scripts/sentry-upload-gate.js), run through the real
 * `@sentry/esbuild-plugin` and `@sentry/vite-plugin` with the repo's own option objects,
 * real esbuild and a real Vite build of a throwaway fixture. The sibling suites fake
 * those plugins, so they never reach the path that goes quiet: an upload that matches
 * nothing only logs a warning, a single bundle with no map drops out at debug level, and
 * the build exits 0 either way. That is the v0.37.0 and v0.38.0 outcome by another route.
 *
 * No test here can reach Sentry. An unreachable `url` does not sandbox these plugins: the
 * options hardcode org `kangentic`, and a fake-token build with SENTRY_URL pointed at
 * localhost still reached a live Sentry host through a region cached by this machine's
 * `sentry` login. So the `sentry` package itself is replaced in Node's require cache
 * before either plugin loads, and the real one never runs. `sourcemap.upload` on that
 * stub reads the prepared folder at the moment of upload, which is the last point it
 * exists. The stub running is asserted, so a wrong cache key fails rather than passes,
 * and every test asserts no socket, fetch or http request was attempted.
 *
 * Each build runs with `process.chdir` into its fixture: the plugins glob build artifacts
 * and `filesToDeleteAfterUpload` from the working directory, and those globs must not touch
 * this checkout's own `.vite/build`.
 *
 * Tier: Unit.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import * as esbuild from 'esbuild';
import { build as viteBuild, type InlineConfig, type PluginOption } from 'vite';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// Resolved from the file that requires it, in case npm ever nests a second copy.
const SENTRY_RESOLVED_PATH = createRequire(require.resolve('@sentry/bundler-plugins/core')).resolve('sentry');

const ORIGINAL_CWD = process.cwd();
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

const GATE_MESSAGE = /took in no sourcemap/;

interface PreparedUpload {
  files: string[];
  /** The `debug_id` of each `.js.map` in the prepared folder. */
  debugIds: unknown[];
}

const uploads: PreparedUpload[] = [];
let uploadError: Error | undefined;
let originalSentryCacheEntry: NodeModule | undefined;

function fakeCreateSentrySDK(): unknown {
  return {
    release: {
      create: async () => undefined,
      finalize: async () => undefined,
      'set-commits': async () => undefined,
      deploy: async () => undefined,
    },
    sourcemap: {
      upload: async ({ directory }: { directory: string }): Promise<void> => {
        if (uploadError) throw uploadError;
        const files = fs.readdirSync(directory).sort();
        const debugIds = files
          .filter((file) => file.endsWith('.js.map'))
          .map((file) => (JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8')) as { debug_id?: unknown }).debug_id);
        uploads.push({ files, debugIds });
      },
    },
    run: async () => ({}),
  };
}

beforeAll(() => {
  originalSentryCacheEntry = require.cache[SENTRY_RESOLVED_PATH];
  require.cache[SENTRY_RESOLVED_PATH] = {
    id: SENTRY_RESOLVED_PATH,
    filename: SENTRY_RESOLVED_PATH,
    loaded: true,
    exports: { createSentrySDK: fakeCreateSentrySDK },
  } as unknown as NodeJS.Module;
});

afterAll(() => {
  if (originalSentryCacheEntry) {
    require.cache[SENTRY_RESOLVED_PATH] = originalSentryCacheEntry;
  } else {
    delete require.cache[SENTRY_RESOLVED_PATH];
  }
});

let fixtureDir: string;
let networkSpies: Array<{ mock: { calls: unknown[][] } }>;

function refuseNetwork(): never {
  throw new Error('a test in this file tried to open a connection');
}

beforeEach(() => {
  vi.resetModules();
  uploads.length = 0;
  uploadError = undefined;
  fixtureDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sentry-upload-gate-')));

  vi.stubEnv('KANGENTIC_SENTRY_TOKEN', 'fake-token');
  vi.stubEnv('SENTRY_AUTH_TOKEN', '');
  vi.stubEnv('CI', 'true');
  vi.stubEnv('KANGENTIC_SENTRY_UPLOAD', '');
  process.env.NODE_ENV = 'production';

  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  networkSpies = [
    vi.spyOn(globalThis, 'fetch').mockImplementation(refuseNetwork),
    vi.spyOn(http, 'request').mockImplementation(refuseNetwork),
    vi.spyOn(https, 'request').mockImplementation(refuseNetwork),
    vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(refuseNetwork),
  ];
});

afterEach(async () => {
  const attempts = networkSpies.reduce((total, spy) => total + spy.mock.calls.length, 0);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (ORIGINAL_NODE_ENV === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  }
  try {
    expect(attempts).toBe(0);
  } finally {
    // Async, because it is the form that retries. On Windows a finished Vite build holds
    // the fixture for under a second, and `rmSync` gives up on that EPERM at once.
    await fs.promises.rm(fixtureDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

/** Only the build itself runs from the fixture, never the plugin loading before it. */
async function runInFixture<Result>(build: () => Promise<Result>): Promise<Result> {
  process.chdir(fixtureDir);
  try {
    return await build();
  } finally {
    process.chdir(ORIGINAL_CWD);
  }
}

function writeFixtureFile(relativePath: string, contents: string): string {
  const filePath = path.join(fixtureDir, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
  return filePath;
}

function loggedLines(): string {
  return vi.mocked(console.log).mock.calls.map((call) => String(call[0])).join('\n');
}

describe('the esbuild half', () => {
  async function loadRepoPlugins(): Promise<esbuild.Plugin[]> {
    const buildModule = await import('../../scripts/build.js');
    return buildModule.resolveSentryEsbuildPlugins() as esbuild.Plugin[];
  }

  function fixtureBuild(
    plugins: esbuild.Plugin[],
    name: string,
    sourcemap: esbuild.BuildOptions['sourcemap'],
  ): Promise<esbuild.BuildResult> {
    return runInFixture(() => esbuild.build({
      entryPoints: [writeFixtureFile(`src/${name}.js`, `console.log(${JSON.stringify(name)});`)],
      outfile: path.join(fixtureDir, '.vite', 'build', `${name}.js`),
      // esbuild takes its default working directory once, when it loads.
      absWorkingDir: fixtureDir,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      minify: true,
      sourcemap,
      plugins,
      logLevel: 'silent',
    }));
  }

  it('passes a bundle whose map reached the upload, and says so', async () => {
    await fixtureBuild(await loadRepoPlugins(), 'main-bundle', 'external');

    expect(uploads).toHaveLength(1);
    const [upload] = uploads;
    expect(upload.files).toHaveLength(2);
    expect(upload.files.filter((file) => file.endsWith('.js.map'))).toHaveLength(1);
    expect(upload.debugIds[0]).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/));
    expect(fs.existsSync(path.join(fixtureDir, '.vite', 'build', 'main-bundle.js'))).toBe(true);
    expect(fs.existsSync(path.join(fixtureDir, '.vite', 'build', 'main-bundle.js.map'))).toBe(false);
    expect(loggedLines()).toContain('Sentry sourcemaps: uploaded');
  });

  it('fails a build whose bundle has no map, which the plugin only warns about', async () => {
    await expect(fixtureBuild(await loadRepoPlugins(), 'main-bundle', false)).rejects.toThrow(GATE_MESSAGE);

    expect(uploads).toEqual([]);
  });

  it('names the one bundle that dropped out when the others uploaded', async () => {
    const plugins = await loadRepoPlugins();
    await fixtureBuild(plugins, 'uploaded-bundle', 'external');

    const failure = await fixtureBuild(plugins, 'dropped-bundle', false).then(() => undefined, (error: Error) => error);

    expect(failure?.message).toMatch(GATE_MESSAGE);
    expect(failure?.message).toContain('dropped-bundle.js');
    expect(failure?.message).not.toContain('uploaded-bundle.js');
    expect(uploads).toHaveLength(1);
  });

  it('leaves a rejected upload reporting its own error', async () => {
    uploadError = new Error('Failed to upload: 401');

    const failure = await fixtureBuild(await loadRepoPlugins(), 'main-bundle', 'external').then(() => undefined, (error: Error) => error);

    expect(failure?.message).toContain('Failed to upload: 401');
    expect(failure?.message).not.toMatch(GATE_MESSAGE);
  });
});

describe('the esbuild gate when a build reports nothing to check', () => {
  // Hook calls rather than a build: a real esbuild run always reports its outputs, and the
  // metafile-less shape only exists if the Sentry plugin that turns it on were removed.
  type BuildResult = { errors: unknown[]; metafile?: { outputs: Record<string, unknown> } };

  async function captureOnEnd(): Promise<(result: BuildResult) => void> {
    const { createSourcemapUploadLedger, createEsbuildUploadGate } = await import('../../scripts/sentry-upload-gate.js');
    const gate = createEsbuildUploadGate(createSourcemapUploadLedger()) as {
      setup(build: { onEnd: (callback: (result: BuildResult) => void) => void }): void;
    };
    let captured: ((result: BuildResult) => void) | undefined;
    gate.setup({ onEnd: (callback) => { captured = callback; } });
    if (!captured) throw new Error('the gate did not register an onEnd callback');
    return captured;
  }

  it('fails a build whose metafile lists no outputs', async () => {
    const onEnd = await captureOnEnd();

    expect(() => onEnd({ errors: [], metafile: { outputs: {} } })).toThrow(/no JavaScript output/);
  });

  it('fails a build with no metafile at all, as if the plugin that enables it were removed', async () => {
    const onEnd = await captureOnEnd();

    expect(() => onEnd({ errors: [] })).toThrow(/no JavaScript output/);
  });

  it('does not count a lone .js.map as JavaScript output', async () => {
    const onEnd = await captureOnEnd();

    expect(() => onEnd({ errors: [], metafile: { outputs: { '.vite/build/index.js.map': {} } } })).toThrow(/no JavaScript output/);
  });

  it('leaves an already failed build to report its own error', async () => {
    const onEnd = await captureOnEnd();

    expect(() => onEnd({ errors: [new Error('build broke')], metafile: { outputs: {} } })).not.toThrow();
  });
});

describe('the sourcemap upload ledger', () => {
  async function createLedger(): Promise<{
    resolveSourceMap(bundlePath: string): unknown;
    has(bundlePath: string): boolean;
  }> {
    const { createSourcemapUploadLedger } = await import('../../scripts/sentry-upload-gate.js');
    return createSourcemapUploadLedger();
  }

  it('records a bundle only when a map sits beside it, and returns nothing either way', async () => {
    const ledger = await createLedger();
    const withMap = writeFixtureFile('with-map.js', 'bundle');
    writeFixtureFile('with-map.js.map', '{}');
    const withoutMap = writeFixtureFile('without-map.js', 'bundle');

    // A return value would replace the plugin's own map search.
    expect(ledger.resolveSourceMap(withMap)).toBeUndefined();
    expect(ledger.resolveSourceMap(withoutMap)).toBeUndefined();

    expect(ledger.has(withMap)).toBe(true);
    expect(ledger.has(withoutMap)).toBe(false);
  });

  it('treats a cwd-relative path and its absolute form as the same bundle', async () => {
    const ledger = await createLedger();
    const absolutePath = writeFixtureFile('assets/index.js', 'bundle');
    writeFixtureFile('assets/index.js.map', '{}');

    await runInFixture(async () => {
      const relativePath = path.relative(process.cwd(), absolutePath);
      expect(path.isAbsolute(relativePath)).toBe(false);

      ledger.resolveSourceMap(relativePath);
      expect(ledger.has(absolutePath)).toBe(true);
      expect(ledger.has(relativePath)).toBe(true);
    });
  });

  it('answers an absolute record with a relative lookup', async () => {
    const ledger = await createLedger();
    const absolutePath = writeFixtureFile('assets/other.js', 'bundle');
    writeFixtureFile('assets/other.js.map', '{}');

    ledger.resolveSourceMap(absolutePath);

    await runInFixture(async () => {
      expect(ledger.has(path.relative(process.cwd(), absolutePath))).toBe(true);
    });
  });
});

describe('which renderer chunks the gate holds to the upload', () => {
  // Hook calls rather than a build: which chunks a real build leaves without a map
  // depends on how it splits, and a fixture cannot be made to reproduce that on demand.
  type WriteBundle = (bundle: Record<string, unknown>) => void;

  async function createGate(): Promise<{ writeBundle: WriteBundle; recordUpload: (fileName: string) => void }> {
    const { createSourcemapUploadLedger, createViteUploadGate } = await import('../../scripts/sentry-upload-gate.js');
    const ledger = createSourcemapUploadLedger();
    const gate = createViteUploadGate(ledger) as {
      writeBundle: { handler(outputOptions: { dir: string }, bundle: Record<string, unknown>): void };
    };
    return {
      writeBundle: (bundle) => gate.writeBundle.handler({ dir: fixtureDir }, bundle),
      recordUpload: (fileName) => {
        writeFixtureFile(`${fileName}.map`, '{}');
        ledger.resolveSourceMap(path.join(fixtureDir, fileName));
      },
    };
  }

  const chunk = (fileName: string, isEntry = false): Record<string, unknown> => ({ type: 'chunk', fileName, isEntry });
  const asset = (fileName: string): Record<string, unknown> => ({ type: 'asset', fileName });

  it('does not wait on a chunk the bundler wrote no map for, as rolldown does for its runtime', async () => {
    const { writeBundle, recordUpload } = await createGate();
    recordUpload('assets/index.js');

    expect(() => writeBundle({
      'assets/index.js': chunk('assets/index.js', true),
      'assets/index.js.map': asset('assets/index.js.map'),
      'assets/rolldown-runtime.js': chunk('assets/rolldown-runtime.js'),
    })).not.toThrow();
    expect(loggedLines()).toContain('uploaded 1 of 2 chunks');
  });

  it('does not wait on a worker bundle, which has a map but is an asset', async () => {
    const { writeBundle, recordUpload } = await createGate();
    recordUpload('assets/index.js');

    expect(() => writeBundle({
      'assets/index.js': chunk('assets/index.js', true),
      'assets/index.js.map': asset('assets/index.js.map'),
      'assets/editor.worker.js': asset('assets/editor.worker.js'),
      'assets/editor.worker.js.map': asset('assets/editor.worker.js.map'),
    })).not.toThrow();
  });

  it('fails when one chunk with a map dropped out and the entry uploaded', async () => {
    const { writeBundle, recordUpload } = await createGate();
    recordUpload('assets/index.js');

    expect(() => writeBundle({
      'assets/index.js': chunk('assets/index.js', true),
      'assets/index.js.map': asset('assets/index.js.map'),
      'assets/lazy.js': chunk('assets/lazy.js'),
      'assets/lazy.js.map': asset('assets/lazy.js.map'),
    })).toThrow(/took in no sourcemap for assets\/lazy\.js\./);
  });

  it('fails an entry chunk that has no map, since nothing else is left to fail with maps off', async () => {
    const { writeBundle } = await createGate();

    expect(() => writeBundle({ 'assets/index.js': chunk('assets/index.js', true) })).toThrow(GATE_MESSAGE);
  });

  it('fails a build that wrote no chunks to check', async () => {
    const { writeBundle } = await createGate();

    expect(() => writeBundle({ 'index.html': asset('index.html') })).toThrow(/nothing to check/);
  });
});

describe('the Vite half', () => {
  const OUT_DIR = path.join('.vite', 'build', 'renderer', 'main_window');

  type SentryConfigFactory = (env: { mode: string }) => { plugins: PluginOption[] };

  /** The Sentry plugin and the gate exactly as vite.config.mts builds them, without the
   *  React, Tailwind and Lingui plugins a throwaway fixture has no use for. */
  async function loadRepoPlugins(): Promise<PluginOption[]> {
    const configFactory = (await import('../../vite.config.mts')).default as unknown as SentryConfigFactory;
    return configFactory({ mode: 'production' }).plugins.flat().filter((plugin) => (
      plugin !== null
      && typeof plugin === 'object'
      && 'name' in plugin
      && plugin.name.includes('sentry')
    ));
  }

  function writeRendererFixture(): void {
    writeFixtureFile('index.html', '<!doctype html><script type="module" src="/main.js"></script>');
    writeFixtureFile('main.js', [
      "new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });",
      "import('./lazy.js').then((module) => module.start());",
    ].join('\n'));
    writeFixtureFile('lazy.js', "export function start() { console.log('lazy chunk'); }");
    writeFixtureFile('worker.js', "postMessage('worker bundle');");
  }

  function fixtureBuild(plugins: PluginOption[], sourcemap: 'hidden' | false): ReturnType<typeof viteBuild> {
    const config: InlineConfig = {
      configFile: false,
      root: fixtureDir,
      mode: 'production',
      logLevel: 'silent',
      plugins,
      build: { outDir: path.join(fixtureDir, OUT_DIR), emptyOutDir: true, sourcemap },
    };
    return runInFixture(() => viteBuild(config));
  }

  it('checks the upload after it finishes, holding chunks but not worker bundles to it', async () => {
    writeRendererFixture();

    await fixtureBuild(await loadRepoPlugins(), 'hidden');

    expect(uploads).toHaveLength(1);
    const [upload] = uploads;
    // The entry and the lazy chunk, each a `.js` and a `.js.map`, and no worker.
    expect(upload.files).toHaveLength(4);
    expect(upload.debugIds).toEqual([expect.any(String), expect.any(String)]);
    expect(loggedLines()).toContain('Sentry sourcemaps: uploaded 2 of 2 chunks');
    // The fixture really did carry a worker, so the count above exempted one.
    const assets = fs.readdirSync(path.join(fixtureDir, OUT_DIR, 'assets'));
    expect(assets.some((asset) => asset.startsWith('worker'))).toBe(true);
  });

  it('leaves a rejected upload reporting its own error, with no line saying it uploaded', async () => {
    writeRendererFixture();
    uploadError = new Error('Failed to upload: 401');

    await expect(fixtureBuild(await loadRepoPlugins(), 'hidden')).rejects.toThrow(/Failed to upload: 401/);

    expect(loggedLines()).not.toContain('Sentry sourcemaps: uploaded');
  });

  it('goes when the web demo drops the Sentry plugins, which is by the name prefix', async () => {
    // demo/vite.config.mts reuses this config and filters on `sentry-`. A gate left behind
    // would find no upload and fail the demo build.
    const demoConfig = fs.readFileSync(path.join(ORIGINAL_CWD, 'demo', 'vite.config.mts'), 'utf8');
    expect(demoConfig).toContain("!plugin.name.startsWith('sentry-')");

    const names = (await loadRepoPlugins()).map((plugin) => (plugin as { name: string }).name);

    // The prefix and the order, not the exact list, which would follow the Sentry
    // plugin's internal names across a bump. Last, so it reads the ledger after the upload.
    expect(names.length).toBeGreaterThan(1);
    expect(names.filter((name) => !name.startsWith('sentry-'))).toEqual([]);
    expect(names.at(-1)).toBe('sentry-upload-gate');
  });

  it('fails a renderer build with no maps, which the plugin only warns about', async () => {
    writeRendererFixture();

    await expect(fixtureBuild(await loadRepoPlugins(), false)).rejects.toThrow(GATE_MESSAGE);

    expect(uploads).toEqual([]);
  });
});
