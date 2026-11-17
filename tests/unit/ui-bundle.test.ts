import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REQUIRED_TEST_HOOKS, UI_BUNDLE_DIRECTORY, missingTestHooks } from '../../scripts/build-ui-bundle.mjs';
import { readBuildBase } from '../../demo/static-server.mjs';
import { readWorkflow } from './helpers/read-workflow';

// On CI the UI tier loads the app from a static bundle, and locally from the Vite dev server
// unless a flag says otherwise. A spec that only the dev server can serve passes on a developer's
// machine and fails on CI, and a bundle built without the development flags fails every spec at
// once. These pins are what catches either before a CI run does. Tier: Unit.

const REPO_ROOT = path.resolve(__dirname, '../..');
const UI_DIRECTORY = path.join(REPO_ROOT, 'tests', 'ui');

/** What a line does that only the Vite dev server can answer. */
interface DevServerNeed {
  line: number;
  reason: string;
}

/**
 * The lines of a UI test file that need the dev server itself. A bundle serves no source path
 * and inlines `?raw` text, so each of these works only against `npx vite`:
 * - a string that is a source path (`'/src/renderer/x.ts'`, `'**' + '/src/renderer/App.tsx*'`),
 *   whether it is imported in place or held in a variable first,
 * - a route on a source file by name (`route('**' + '/ChangesPanel.tsx*')`) or on a `?raw` import,
 * - a request matched by its source extension (`pathname.endsWith('/icon-registry.ts')`).
 * Comment lines are skipped: several specs describe the old shape in prose.
 */
function findDevServerNeeds(source: string): DevServerNeed[] {
  const needs: DevServerNeed[] = [];
  source.replace(/\r\n/g, '\n').split('\n').forEach((text, index) => {
    const trimmed = text.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
    if (/['"`](\*\*)?\/src\//.test(text)) {
      needs.push({ line: index + 1, reason: 'names a source path' });
    } else if (/\.route\(\s*['"`/][^)]*(\.tsx?\b|\?.*raw)/.test(text)) {
      needs.push({ line: index + 1, reason: 'routes on a source file' });
    } else if (/\.endsWith\(\s*['"`][^'"`]*\.tsx?['"`]\s*\)/.test(text)) {
      needs.push({ line: index + 1, reason: 'matches a request by its source extension' });
    }
  });
  return needs;
}

function usesDevServerUrl(source: string): boolean {
  return /import \{[^}]*\bDEV_SERVER_URL\b[^}]*\} from '\.\/dev-server'/.test(source);
}

function uiTestFiles(): string[] {
  return fs.readdirSync(UI_DIRECTORY, { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.d.ts'))
    .map((name) => name.replace(/\\/g, '/'))
    .sort();
}

describe('a UI spec that needs the dev server says so', () => {
  const files = uiTestFiles().map((name) => ({ name, source: fs.readFileSync(path.join(UI_DIRECTORY, name), 'utf8') }));

  it('reads the UI specs (proves the walk still matches)', () => {
    expect(files.length).toBeGreaterThan(300);
    expect(files.map((file) => file.name)).toEqual(expect.arrayContaining(['app.spec.ts', 'helpers.ts', 'dev-server.ts']));
  });

  it('finds each shape in known source, and passes what a bundle can serve', () => {
    expect(findDevServerNeeds("const gate = await import('/src/renderer/gate.ts');\n")).toHaveLength(1);
    expect(findDevServerNeeds("const storeModule = '/src/renderer/stores/session-store.ts';\n")).toHaveLength(1);
    expect(findDevServerNeeds("const APP_MODULE = '**/src/renderer/App.tsx*';\n")).toHaveLength(1);
    expect(findDevServerNeeds("await page.route('**/ChangesPanel.tsx*', (route) => route.abort());\n")).toHaveLength(1);
    expect(findDevServerNeeds('await target.route(/RELEASE_NOTES\\.md\\?.*raw/, (route) => route.fulfill({}));\n')).toHaveLength(1);
    expect(findDevServerNeeds("if (pathname.endsWith('/icon-registry.ts')) registryUrl = request.url();\n")).toHaveLength(1);

    expect(findDevServerNeeds("// it used to call import('/src/renderer/gate.ts') in the page\n")).toEqual([]);
    expect(findDevServerNeeds("await page.route(isCatalogUrl, handler);\n")).toEqual([]);
    expect(findDevServerNeeds("await page.route('**/api/issues*', (route) => route.abort());\n")).toEqual([]);
    expect(findDevServerNeeds("import { launchPage } from './helpers';\n")).toEqual([]);
    expect(findDevServerNeeds('const modules = window.__kangenticTestModules;\n')).toEqual([]);
  });

  it('takes its URL from tests/ui/dev-server.ts whenever it does something only the dev server answers', () => {
    const offenders = files
      .filter((file) => file.name !== 'dev-server.ts' && !usesDevServerUrl(file.source))
      .flatMap((file) => findDevServerNeeds(file.source).map((need) => `tests/ui/${file.name}:${need.line} ${need.reason}`));
    expect(
      offenders,
      'These lines work against the Vite dev server and not against the bundle CI serves the UI tier. '
      + 'Read the module through window.__kangenticTestModules or window.__zustandStores (src/renderer/App.tsx), '
      + 'or load the page from DEV_SERVER_URL (tests/ui/dev-server.ts).',
    ).toEqual([]);
  });

  it('keeps the shared helpers off the dev server, since every spec on the bundle calls them', () => {
    const helpers = files.find((file) => file.name === 'helpers.ts');
    expect(helpers).toBeDefined();
    expect(findDevServerNeeds(helpers?.source ?? '')).toEqual([]);
  });

  it('holds no spec on the dev server that no longer needs it', () => {
    // A spec on the dev server pays its slow boot. One that stopped needing it should come back.
    const stale = files
      .filter((file) => usesDevServerUrl(file.source) && findDevServerNeeds(file.source).length === 0)
      .map((file) => `tests/ui/${file.name}`);
    expect(stale).toEqual([]);
  });

  it('finds the specs known to need it', () => {
    const onDevServer = files.filter((file) => usesDevServerUrl(file.source)).map((file) => file.name);
    expect(onDevServer).toEqual(expect.arrayContaining([
      'dev-restart.spec.ts',
      'goto-vite-boot-retry.spec.ts',
      'changes-panel-lazy-retry.spec.ts',
      'stats-lazy-retry.spec.ts',
      'task-changes-dialog-lazy-retry.spec.ts',
      'tooltip-behaviour.spec.ts',
    ]));
  });
});

describe('the UI bundle keeps the test hooks', () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  });

  function bundleWith(scripts: Record<string, string>): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-bundle-test-'));
    temporaryDirectories.push(directory);
    fs.mkdirSync(path.join(directory, 'assets'));
    for (const [name, body] of Object.entries(scripts)) fs.writeFileSync(path.join(directory, 'assets', name), body);
    return directory;
  }

  it('passes a bundle whose scripts mention every hook, in any chunk', () => {
    const directory = bundleWith({
      'index-a1.js': 'window.__zustandStores = {};',
      'vendor-b2.js': 'window.__kangenticTestModules = {};',
    });
    expect(missingTestHooks(directory)).toEqual([]);
  });

  it('names the hooks a production-shaped bundle dropped', () => {
    const directory = bundleWith({ 'index-a1.js': 'console.log("no dev block");', 'style.css': '__zustandStores' });
    expect(missingTestHooks(directory)).toEqual(REQUIRED_TEST_HOOKS);
  });

  it('names every hook when there is no bundle at all', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-bundle-test-'));
    temporaryDirectories.push(directory);
    expect(missingTestHooks(directory)).toEqual(REQUIRED_TEST_HOOKS);
  });

  it('checks for hooks the renderer really sets, inside its development block', () => {
    const appSource = fs.readFileSync(path.join(REPO_ROOT, 'src', 'renderer', 'App.tsx'), 'utf8').replace(/\r\n/g, '\n');
    const developmentBlock = appSource.slice(appSource.lastIndexOf('if (import.meta.env.DEV) {'));
    expect(REQUIRED_TEST_HOOKS.length).toBeGreaterThan(0);
    for (const hook of REQUIRED_TEST_HOOKS) {
      expect(developmentBlock, `App.tsx no longer sets window.${hook} in its development block`).toContain(`.${hook} = {`);
    }
  });

  it('builds the development app: NODE_ENV and the mode both say so, before vite loads', () => {
    // Either one alone compiles hooks out: NODE_ENV decides import.meta.env.DEV, the mode decides
    // __KANGENTIC_DEV__ (vite.config.mts). The script cannot be run here, since it builds.
    const script = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'build-ui-bundle.mjs'), 'utf8').replace(/\r\n/g, '\n');
    const setsNodeEnv = script.indexOf("process.env.NODE_ENV = 'development';");
    const loadsVite = script.indexOf("await import('vite')");
    expect(setsNodeEnv).toBeGreaterThan(-1);
    expect(loadsVite).toBeGreaterThan(setsNodeEnv);
    expect(script).toContain("mode: 'development',");
    const viteConfig = fs.readFileSync(path.join(REPO_ROOT, 'vite.config.mts'), 'utf8');
    expect(viteConfig).toContain("__KANGENTIC_DEV__: JSON.stringify(mode !== 'production')");
  });
});

describe('the static server serves a bundle built for the root', () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  });

  function buildWithScript(scriptSource: string): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-bundle-base-'));
    temporaryDirectories.push(directory);
    fs.writeFileSync(path.join(directory, 'index.html'), `<!doctype html><script type="module" crossorigin src="${scriptSource}"></script>`);
    return directory;
  }

  it('reads the base "/" from a root build, which the UI bundle is', () => {
    expect(readBuildBase(buildWithScript('/assets/index-abc123.js'))).toBe('/');
  });

  it('still reads a mounted base, as the web demo has', () => {
    expect(readBuildBase(buildWithScript('/demo/assets/index-abc123.js'))).toBe('/demo/');
  });

  it('refuses a directory with no build in it', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-bundle-base-'));
    temporaryDirectories.push(directory);
    expect(() => readBuildBase(directory)).toThrow('No web build');
  });
});

describe('ci.yml runs the UI tier on the bundle', () => {
  const ciSource = readWorkflow('ci.yml');
  const start = ciSource.indexOf('\n  playwright-shards:\n');
  const uiJob = ciSource.slice(start, ciSource.indexOf('\n  ui:\n', start));

  it('builds the bundle before the run that needs it', () => {
    expect(start).toBeGreaterThan(-1);
    const build = uiJob.indexOf('run: node scripts/build-ui-bundle.mjs');
    const run = uiJob.indexOf('run: npx playwright test --project=ui');
    expect(build).toBeGreaterThan(-1);
    expect(run).toBeGreaterThan(build);
  });

  it('sets the flag on the run, without which Playwright serves the dev server and the build is unused', () => {
    expect(uiJob).toMatch(/ {8}env:\n {10}KANGENTIC_UI_BUNDLE: '1'\n {8}run: npx playwright test --project=ui/);
  });

  it('serves the bundle from the directory the build writes', () => {
    const serveScript = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'serve-ui-bundle.mjs'), 'utf8');
    expect(serveScript).toContain('UI_BUNDLE_DIRECTORY');
    expect(UI_BUNDLE_DIRECTORY).toBe('dist/ui-bundle');
    const config = fs.readFileSync(path.join(REPO_ROOT, 'playwright.config.ts'), 'utf8');
    expect(config).toContain("process.env.KANGENTIC_UI_BUNDLE === '1'");
    expect(config).toContain('node scripts/serve-ui-bundle.mjs --port ${vitePort}');
  });
});
