import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// Every shot of the web demo (the posters, the captures, the measurements, the demo tier) is taken
// in Playwright's bundled Chromium, and Playwright launches it with --disable-extensions among its
// default switches. So no extension can draw into a recording or a poster, as long as no launch
// opts back in. This test fails on the ways a launch could: a persistent context (a real profile,
// which is where installed extensions live), an installed browser channel, a --load-extension
// switch, or an ignoreDefaultArgs that drops --disable-extensions or every default at once. The
// live frame in a visitor's browser is demo/boot.js's job (demo/README.md, Browser extensions).

const REPO_ROOT = path.resolve(__dirname, '../..');
const SCAN_DIRS = ['demo', 'tests/captures', 'tests/demo', 'scripts'];
const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs']);
const SKIP_DIRECTORY_NAMES = new Set(['node_modules']);

/** The launches that exist today. Each must be found and must pass, so the scan cannot pass on nothing. */
const KNOWN_LAUNCH_SITES = [
  'tests/captures/helpers/capture-page.ts',
  'tests/captures/features/walkthrough.capture.ts',
  'demo/measure.mjs',
  'tests/demo/static-demo.spec.ts',
];

const IMPORTS_PLAYWRIGHT = /(?:from\s+|require\(\s*)['"](?:@playwright\/test|playwright(?:-core)?)['"]/;

interface LaunchRule {
  description: string;
  pattern: RegExp;
  /** Only files that import Playwright, for a pattern that is common outside it. */
  playwrightOnly?: boolean;
}

const LAUNCH_RULES: LaunchRule[] = [
  { description: 'a persistent context runs a real profile, with its extensions', pattern: /\blaunchPersistentContext\b/g },
  { description: '--load-extension loads an extension', pattern: /--load-extension/g },
  { description: 'ignoreDefaultArgs: true drops --disable-extensions with every other default', pattern: /ignoreDefaultArgs\s*:\s*true\b/g },
  { description: 'ignoreDefaultArgs names --disable-extensions', pattern: /ignoreDefaultArgs\s*:\s*\[[^\]]*--disable-extensions/g },
  { description: 'a channel launches an installed browser, not the bundled one', pattern: /\bchannel\s*:\s*['"`]/g, playwrightOnly: true },
];

function collectCodeFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORY_NAMES.has(entry.name)) continue;
      files.push(...collectCodeFiles(fullPath));
    } else if (CODE_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(fullPath);
    }
  }
  return files;
}

function collectScannedFiles(): string[] {
  const files: string[] = [];
  for (const scanDir of SCAN_DIRS) {
    const absoluteDir = path.join(REPO_ROOT, scanDir);
    if (!fs.existsSync(absoluteDir)) {
      throw new Error(`Scanned tree '${scanDir}' is missing, so its coverage silently vanished.`);
    }
    files.push(...collectCodeFiles(absoluteDir));
  }
  return files;
}

function relativePosixPath(filePath: string): string {
  return path.relative(REPO_ROOT, filePath).replace(/\\/g, '/');
}

/** Every launch rule a source breaks, as `<line>: <why>`. */
function findExtensionLaunches(source: string): string[] {
  const findings: string[] = [];
  const importsPlaywright = IMPORTS_PLAYWRIGHT.test(source);
  for (const rule of LAUNCH_RULES) {
    if (rule.playwrightOnly && !importsPlaywright) continue;
    for (const match of source.matchAll(rule.pattern)) {
      const line = source.slice(0, match.index).split('\n').length;
      findings.push(`${line}: ${rule.description}`);
    }
  }
  return findings;
}

describe('the demo captures and tiers run no browser extension', () => {
  it('no launch opts out of Playwright\'s --disable-extensions', () => {
    const offenders: string[] = [];
    for (const filePath of collectScannedFiles()) {
      for (const finding of findExtensionLaunches(fs.readFileSync(filePath, 'utf-8'))) {
        offenders.push(`${relativePosixPath(filePath)}:${finding}`);
      }
    }
    expect(
      offenders,
      `A launch here would let a browser extension draw into a demo shot. Launch Playwright's bundled Chromium with its default switches (an ignoreDefaultArgs may name only switches other than --disable-extensions). See demo/README.md, Browser extensions.\nOffenders:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('finds the launches that exist today', () => {
    const scanned = new Set(collectScannedFiles().map(relativePosixPath));
    for (const site of KNOWN_LAUNCH_SITES) {
      expect(scanned.has(site), `${site} is no longer scanned`).toBe(true);
      expect(fs.readFileSync(path.join(REPO_ROOT, site), 'utf-8'), `${site} no longer launches Chromium; update KNOWN_LAUNCH_SITES`).toMatch(/chromium\.launch\(/);
    }
  });

  it('Playwright still launches Chromium with --disable-extensions', () => {
    // The whole guarantee rests on this default. Read it from the installed package, so an upgrade
    // that drops it fails here rather than letting an extension into the next poster set.
    const packageDir = path.dirname(require.resolve('playwright-core/package.json'));
    const libFiles = collectCodeFiles(path.join(packageDir, 'lib'));
    const switchLists = libFiles
      .map((filePath) => fs.readFileSync(filePath, 'utf-8'))
      .map((source) => {
        const start = source.indexOf('chromiumSwitches = ');
        if (start === -1) return null;
        const end = source.indexOf('];', start);
        return end === -1 ? null : source.slice(start, end);
      })
      .filter((list): list is string => list !== null);
    expect(switchLists.length, 'playwright-core no longer defines chromiumSwitches where this test looks').toBeGreaterThan(0);
    expect(switchLists.some((list) => list.includes('"--disable-extensions"'))).toBe(true);
  });
});

describe('findExtensionLaunches', () => {
  it('passes the launches the demo uses', () => {
    expect(findExtensionLaunches(`import { chromium } from '@playwright/test';\nawait chromium.launch({ headless: true, args: ['--force-device-scale-factor=2'] });`)).toEqual([]);
    expect(findExtensionLaunches(`import { chromium } from '@playwright/test';\nawait chromium.launch({ headless: true, ignoreDefaultArgs: ['--hide-scrollbars'] });`)).toEqual([]);
  });

  it('flags each way a launch takes extensions back', () => {
    expect(findExtensionLaunches(`import { chromium } from '@playwright/test';\nawait chromium.launchPersistentContext(dir);`)).toHaveLength(1);
    expect(findExtensionLaunches(`await chromium.launch({ args: ['--load-extension=/ext'] });`)).toHaveLength(1);
    expect(findExtensionLaunches(`await chromium.launch({ ignoreDefaultArgs: true });`)).toHaveLength(1);
    expect(findExtensionLaunches(`await chromium.launch({\n  ignoreDefaultArgs: ['--hide-scrollbars',\n    '--disable-extensions'],\n});`)).toEqual(['2: ignoreDefaultArgs names --disable-extensions']);
    expect(findExtensionLaunches(`import { chromium } from 'playwright';\n\nawait chromium.launch({ channel: 'chrome' });`)).toEqual(['3: a channel launches an installed browser, not the bundled one']);
  });

  it('leaves a channel alone in a file that does not launch a browser', () => {
    expect(findExtensionLaunches(`const message = { channel: 'session:spawn' };`)).toEqual([]);
  });
});
