/**
 * Unit coverage for the two Sentry upload guards in vite.config.mts:
 * resolveSentryVitePlugins()'s throw-unless-NODE_ENV-is-"production", and
 * resolveSentryReleaseName()'s throw-on-missing-version.
 *
 * Both mirror already-tested siblings in scripts/build.js
 * (assertUploadCanActuallyRun / resolveSentryReleaseName, covered by
 * upload-native-debug-files.test.ts) but neither is exported from
 * vite.config.mts, and no test evaluated this config module at all before
 * this file - tests/unit/renderer-optimize-deps-parity.test.ts only reads it
 * as source text. That left the renderer half of the exact
 * "release gate that stops gating without saying so" shape
 * (.claude/rules/release-gates-fail-loudly.md) with zero coverage: a silently
 * broken guard here reproduces the same failure mode that shipped v0.37.0 and
 * v0.38.0 with unreadable renderer stacks, just from the Vite side of the
 * build instead of the esbuild side.
 *
 * `defineConfig(fn)` is confirmed (against the installed `vite` package) to
 * be an identity type-helper: it returns the passed function unchanged, so
 * `(await import('../../vite.config.mts')).default({ mode })` drives the same
 * code path a real `vite build` takes.
 *
 * Both throw-paths run BEFORE the real `sentryVitePlugin()` factory is ever
 * called: the NODE_ENV check is the first statement in
 * resolveSentryVitePlugins(), and the version check runs inside
 * resolveSentryReleaseName(), which is evaluated as an argument to
 * sentryVitePlugin's options object - ahead of the call itself. So neither
 * guard test needs `@sentry/vite-plugin` mocked or faked.
 *
 * Tier: Unit.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

function restoreNodeEnv(): void {
  if (ORIGINAL_NODE_ENV === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  }
}

/**
 * The subset of the real config-factory signature these tests need. The real
 * export is `defineConfig(({ mode }) => ({ plugins, ... }))`; `defineConfig`
 * is an identity helper, so the module's default export IS that function.
 */
type SentryConfigFactory = (env: { mode: string }) => { plugins: unknown[] };

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  // Clear both token env vars so each test starts from the ungated state;
  // scenarios that need a token stub it explicitly. Matches
  // upload-native-debug-files.test.ts's convention for the same pick.
  vi.stubEnv('KANGENTIC_SENTRY_TOKEN', '');
  vi.stubEnv('SENTRY_AUTH_TOKEN', '');
  // Model the CI release build, where GitHub Actions sets CI=true: a token
  // alone does not authorize an upload on a local machine (isSentryUploadAuthorized).
  vi.stubEnv('CI', 'true');
  vi.stubEnv('KANGENTIC_SENTRY_UPLOAD', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.doUnmock('node:fs');
  restoreNodeEnv();
});

describe('vite.config.mts Sentry upload guards', () => {
  it('resolveSentryVitePlugins throws when NODE_ENV is not "production" (token set, mode: production)', async () => {
    vi.stubEnv('KANGENTIC_SENTRY_TOKEN', 'fake-token');
    process.env.NODE_ENV = 'development';

    const configModule = await import('../../vite.config.mts');
    const configFactory = configModule.default as unknown as SentryConfigFactory;

    expect(() => configFactory({ mode: 'production' })).toThrow(
      /a Sentry upload token is set, but NODE_ENV is/,
    );
    expect(() => configFactory({ mode: 'production' })).toThrow(
      /would silently skip the upload and delete the renderer sourcemaps/,
    );
  });

  it('resolveSentryReleaseName throws when package.json has no usable "version" (token set, NODE_ENV production)', async () => {
    vi.stubEnv('KANGENTIC_SENTRY_TOKEN', 'fake-token');
    process.env.NODE_ENV = 'production';

    // resolveSentryReleaseName reads package.json via fs.readFileSync (not
    // require, unlike its build.js sibling), so the require.cache-seeding
    // trick used elsewhere in this test suite does not apply here - mock the
    // module instead. Delegates every other path to the real implementation
    // so the rest of the config's construction (plugin factories, etc.) is
    // unaffected.
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs')>();
      return {
        ...actual,
        readFileSync: (filePath: unknown, options?: unknown) => {
          if (typeof filePath === 'string' && filePath.endsWith('package.json')) {
            return JSON.stringify({ name: 'kangentic' }); // no "version" field
          }
          return actual.readFileSync(filePath as never, options as never);
        },
      };
    });

    const configModule = await import('../../vite.config.mts');
    const configFactory = configModule.default as unknown as SentryConfigFactory;

    expect(() => configFactory({ mode: 'production' })).toThrow(/no usable "version"/);
    expect(() => configFactory({ mode: 'production' })).toThrow(/Kangentic@undefined/);
  });

  it('constructs the Sentry plugin without throwing when NODE_ENV is production and package.json has a version', async () => {
    vi.stubEnv('KANGENTIC_SENTRY_TOKEN', 'fake-token');
    process.env.NODE_ENV = 'production';

    const configModule = await import('../../vite.config.mts');
    const configFactory = configModule.default as unknown as SentryConfigFactory;

    expect(() => configFactory({ mode: 'production' })).not.toThrow();
  });

  it('never reaches either guard when no token is set, whatever NODE_ENV is', async () => {
    // uploadSourcemaps reads false with no token, so resolveSentryVitePlugins()
    // (and both guards inside it) never run at all. This is what keeps a
    // plain tokenless `npm start` / local build silent instead of throwing -
    // a regression here would break every contributor's default build, not
    // just releases.
    process.env.NODE_ENV = 'development';

    const configModule = await import('../../vite.config.mts');
    const configFactory = configModule.default as unknown as SentryConfigFactory;

    expect(() => configFactory({ mode: 'production' })).not.toThrow();
  });

  it('never reaches either guard on a LOCAL build even with a token set', async () => {
    // The dogfooding machine's user-level token is not intent to upload: only
    // CI or KANGENTIC_SENTRY_UPLOAD=1 authorizes it. NODE_ENV 'development'
    // would throw if the plugin were built, so not throwing proves it was not.
    vi.stubEnv('KANGENTIC_SENTRY_TOKEN', 'fake-token');
    vi.stubEnv('CI', '');
    process.env.NODE_ENV = 'development';

    const configModule = await import('../../vite.config.mts');
    const configFactory = configModule.default as unknown as SentryConfigFactory;

    expect(() => configFactory({ mode: 'production' })).not.toThrow();
  });

  it.each(['false', '0'])('never reaches either guard when CI is "%s" even with a token set', async (continuousIntegrationValue) => {
    // CI=false and CI=0 are how a local shell or a workflow says "not CI", so
    // like an empty CI they do not authorize an upload. Mirrors the "false" and
    // "0" exclusions in isSentryUploadAuthorized (scripts/build.js). NODE_ENV
    // 'development' would throw if the plugin were built, so not throwing
    // proves it was not.
    vi.stubEnv('KANGENTIC_SENTRY_TOKEN', 'fake-token');
    vi.stubEnv('CI', continuousIntegrationValue);
    process.env.NODE_ENV = 'development';

    const configModule = await import('../../vite.config.mts');
    const configFactory = configModule.default as unknown as SentryConfigFactory;

    expect(() => configFactory({ mode: 'production' })).not.toThrow();
  });

  it('a local build with KANGENTIC_SENTRY_UPLOAD=1 is authorized and reaches the guards', async () => {
    vi.stubEnv('KANGENTIC_SENTRY_TOKEN', 'fake-token');
    vi.stubEnv('CI', '');
    vi.stubEnv('KANGENTIC_SENTRY_UPLOAD', '1');
    process.env.NODE_ENV = 'development';

    const configModule = await import('../../vite.config.mts');
    const configFactory = configModule.default as unknown as SentryConfigFactory;

    expect(() => configFactory({ mode: 'production' })).toThrow(/a Sentry upload token is set, but NODE_ENV is/);
  });
});

describe('vite.config.mts authorizes an upload exactly when scripts/build.js does', () => {
  // The two halves of a release upload decide authorization separately: the
  // renderer here, main and preload in isSentryUploadAuthorized. A value one
  // accepted and the other refused would upload half a release's symbols with
  // both builds green, so each row runs both and compares.
  const environments: Array<{ CI: string; KANGENTIC_SENTRY_UPLOAD: string }> = [
    { CI: '', KANGENTIC_SENTRY_UPLOAD: '' },
    { CI: 'true', KANGENTIC_SENTRY_UPLOAD: '' },
    { CI: 'TRUE', KANGENTIC_SENTRY_UPLOAD: '' },
    { CI: '1', KANGENTIC_SENTRY_UPLOAD: '' },
    { CI: ' true ', KANGENTIC_SENTRY_UPLOAD: '' },
    { CI: 'false', KANGENTIC_SENTRY_UPLOAD: '' },
    { CI: 'False', KANGENTIC_SENTRY_UPLOAD: '' },
    { CI: '0', KANGENTIC_SENTRY_UPLOAD: '' },
    { CI: ' 0 ', KANGENTIC_SENTRY_UPLOAD: '' },
    { CI: '', KANGENTIC_SENTRY_UPLOAD: '1' },
    { CI: '', KANGENTIC_SENTRY_UPLOAD: ' 1 ' },
    { CI: '', KANGENTIC_SENTRY_UPLOAD: 'true' },
    { CI: '', KANGENTIC_SENTRY_UPLOAD: '0' },
    { CI: 'false', KANGENTIC_SENTRY_UPLOAD: '1' },
  ];

  it('agrees on every row of the table', async () => {
    const buildModule = await import('../../scripts/build.js');
    const buildAuthorizes = buildModule.isSentryUploadAuthorized as (env: Record<string, string | undefined>) => boolean;
    // Positive control: the table holds rows on both sides, so agreement is not two halves that never upload.
    const expected = environments.map((environment) => buildAuthorizes(environment));
    expect(expected).toContain(true);
    expect(expected).toContain(false);

    const disagreements: string[] = [];
    for (const [index, environment] of environments.entries()) {
      vi.resetModules();
      vi.stubEnv('KANGENTIC_SENTRY_TOKEN', 'fake-token');
      vi.stubEnv('CI', environment.CI);
      vi.stubEnv('KANGENTIC_SENTRY_UPLOAD', environment.KANGENTIC_SENTRY_UPLOAD);
      process.env.NODE_ENV = 'development';
      const configFactory = (await import('../../vite.config.mts')).default as unknown as SentryConfigFactory;
      // An authorized upload builds the plugin, whose guard throws under NODE_ENV
      // 'development'; an unauthorized one never builds it.
      let viteAuthorizes = false;
      try {
        configFactory({ mode: 'production' });
      } catch (error) {
        if (!/a Sentry upload token is set, but NODE_ENV is/.test(String(error))) throw error;
        viteAuthorizes = true;
      }
      if (viteAuthorizes !== expected[index]) {
        disagreements.push(`CI=${JSON.stringify(environment.CI)} KANGENTIC_SENTRY_UPLOAD=${JSON.stringify(environment.KANGENTIC_SENTRY_UPLOAD)}: build ${expected[index]}, vite ${viteAuthorizes}`);
      }
    }
    expect(disagreements).toEqual([]);
  });
});
