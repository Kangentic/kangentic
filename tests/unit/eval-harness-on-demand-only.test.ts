/**
 * The Ask harness spends real subscription quota, so it must stay something a
 * person runs deliberately - never a step in a pipeline.
 *
 * That is easy to state and easy to erode: someone adds `"eval": "node
 * scripts/eval-ask.mjs"` to package.json as a convenience, a workflow picks up
 * `npm run eval`, and a pull request quietly costs ten agent calls per push. By
 * the time anyone notices, it has been billing for weeks.
 *
 * So the rule is enforced from three directions rather than trusted:
 *   1. this scan, which fails if anything automated references the runner,
 *   2. the runner's own `refuseIfAutomated`, which exits under CI even if the
 *      wiring gets past the scan,
 *   3. an entry-point guard, so importing the module (as the self-check test
 *      does) cannot execute a run.
 *
 * `--dry` and `--regrade` are exempt in the runner because they spend nothing;
 * this scan does not need to know about that distinction, since the concern
 * here is anything invoking the harness at all from an automated path.
 *
 * The scan looks for a MENTION of the runner's name, not for a call shape. A
 * call-shape pattern (`spawn(...eval-ask`) misses `spawnSync(`, `execFile(`,
 * `execFileSync(`, `fork(`, and a path held in a variable and passed on a later
 * line, and every one of those still runs the harness.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const RUNNER = 'eval-ask';
/** Where a test, a helper or a fixture can live, whatever its folder depth. */
const TEST_EXTENSIONS = ['.ts', '.js', '.mjs'] as const;
const SCRIPT_EXTENSIONS = ['.js', '.mjs'] as const;

function toPosix(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

/** This file, as `tests/...`, so the scan never reads its own constants as a finding. */
const THIS_TEST = toPosix(path.relative(ROOT, __filename));

/**
 * The tests that import the harness for its pure halves, which is how it is
 * meant to be tested and spends nothing. Each may name it only in an import
 * (`importsOnly`), so listing one here cannot hide a spawn of the runner.
 */
const IMPORTING_TESTS: ReadonlySet<string> = new Set(['tests/unit/eval-ask-rollup.test.ts']);

/** Every file under `directory`, at any depth, as '/'-separated paths relative to it. */
function listFiles(directory: string, extensions?: ReadonlyArray<string>): string[] {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { recursive: true, encoding: 'utf-8' })
    .map(toPosix)
    .filter((entry) => extensions === undefined || extensions.includes(path.posix.extname(entry)))
    .filter((entry) => fs.statSync(path.join(directory, entry)).isFile());
}

/** The runner is named anywhere in `text`. */
function mentionsRunner(text: string): boolean {
  return text.includes(RUNNER);
}

/** Lines of `text` that name the runner and are not a comment: code, a string, an import. */
function codeLinesNamingRunner(text: string): string[] {
  return text.split(/\r?\n/).filter((line) => line.includes(RUNNER) && !/^\s*(?:\/\/|\/\*|\*)/.test(line));
}

/** True when every line of `text` that names the runner is a comment or an import of it. */
function importsOnly(text: string): boolean {
  const importOfRunner = /(?:\bfrom\s+|\bimport\s*\(\s*)['"][^'"]*eval-ask\.mjs['"]/;
  return codeLinesNamingRunner(text).every((line) => importOfRunner.test(line));
}

interface Scan {
  /** What was read, so a scan that read nothing cannot pass for one that found nothing. */
  scanned: string[];
  /** What named the runner. */
  offenders: string[];
}

/** Read each of `files` (relative to `directory`, reported as `label/file`) and keep what `names` flags. */
function scanFiles(
  directory: string,
  label: string,
  files: ReadonlyArray<string>,
  names: (text: string, file: string) => boolean,
): Scan {
  const scan: Scan = { scanned: [], offenders: [] };
  for (const file of files) {
    const reported = `${label}/${file}`;
    scan.scanned.push(reported);
    if (names(fs.readFileSync(path.join(directory, file), 'utf-8'), reported)) scan.offenders.push(reported);
  }
  return scan;
}

/** Every file that could cause the harness to run without a person asking, with what each scan read. */
function automatedScans(): Scan[] {
  const scans: Scan[] = [];

  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8')) as {
    scripts?: Record<string, string>;
  };
  const scriptsText = JSON.stringify(manifest.scripts ?? {});
  scans.push({
    scanned: ['package.json scripts'],
    offenders: mentionsRunner(scriptsText) ? ['package.json scripts'] : [],
  });

  // Every workflow, issue template and automation config, at any depth.
  const github = path.join(ROOT, '.github');
  scans.push(scanFiles(github, '.github', listFiles(github), mentionsRunner));

  const playwright = path.join(ROOT, 'playwright.config.ts');
  if (fs.existsSync(playwright)) {
    scans.push(scanFiles(ROOT, '.', ['playwright.config.ts'], mentionsRunner));
  }

  // Other scripts run from npm scripts, hooks and workflows, so one that names
  // the harness in code could be how it gets run. The harness and its question
  // list are exempt. A manual-only probe may cite the harness in prose (as
  // `probe-cache.mjs` does, to say it is manual-only too), so a script is read
  // for code, not comments.
  const scripts = path.join(ROOT, 'scripts');
  const otherScripts = listFiles(scripts, SCRIPT_EXTENSIONS)
    .filter((file) => !path.posix.basename(file).startsWith(RUNNER));
  scans.push(scanFiles(scripts, 'scripts', otherScripts, (text) => codeLinesNamingRunner(text).length > 0));

  return scans;
}

/** Every test, helper and fixture under tests/, at any depth, except what may import the harness. */
function testScan(): Scan {
  const tests = path.join(ROOT, 'tests');
  const files = listFiles(tests, TEST_EXTENSIONS)
    .filter((file) => `tests/${file}` !== THIS_TEST && !IMPORTING_TESTS.has(`tests/${file}`));
  return scanFiles(tests, 'tests', files, mentionsRunner);
}

describe('the Ask harness runs on demand only', () => {
  it('is referenced by no npm script, workflow, or test runner config, nor by a script that is not the harness', () => {
    const scans = automatedScans();
    const offenders = scans.flatMap((scan) => scan.offenders);

    expect(offenders, `${RUNNER} must not be reachable from an automated path`).toEqual([]);
    // Not vacuous: each surface was read, and the walk reached real files.
    for (const scan of scans) expect(scan.scanned.length).toBeGreaterThan(0);
    const scanned = scans.flatMap((scan) => scan.scanned);
    expect(scanned.some((file) => file.startsWith('.github/workflows/'))).toBe(true);
    expect(scanned.some((file) => file.startsWith('scripts/'))).toBe(true);
  });

  it('is named by no test, helper or fixture in the suite', () => {
    // The tests that import the module for its pure halves are the only ones
    // exempt, and they may only import it (checked below).
    const { scanned, offenders } = testScan();

    expect(offenders, 'no test may spend agent quota by running the harness').toEqual([]);
    // Not vacuous: the walk went through every tier, folders below one, and
    // .ts and .js alike.
    expect(scanned.length).toBeGreaterThan(0);
    for (const tier of ['unit', 'ui', 'e2e', 'fixtures']) {
      expect(scanned.some((file) => file.startsWith(`tests/${tier}/`)), `tests/${tier}`).toBe(true);
    }
    expect(scanned.some((file) => file.split('/').length > 3), 'a folder below a tier').toBe(true);
    expect(scanned.some((file) => file.endsWith('.js')), '.js files').toBe(true);
    expect(scanned.some((file) => file.endsWith('.ts')), '.ts files').toBe(true);
  });

  it('lets only an import of the harness through, in the tests that are allowed to import it', () => {
    for (const importer of IMPORTING_TESTS) {
      const absolute = path.join(ROOT, importer);
      expect(fs.existsSync(absolute), `${importer} exists (a stale exemption exempts nothing)`).toBe(true);
      const text = fs.readFileSync(absolute, 'utf-8');
      expect(mentionsRunner(text), `${importer} imports the harness`).toBe(true);
      expect(importsOnly(text), `${importer} names the harness other than by import`).toBe(true);
    }
  });

  describe('the scan itself', () => {
    // Each of these reaches the harness. A call-shape pattern such as
    // `(?:spawn|exec|execSync|execa|run)\s*\([^)]*eval-ask` (the scan this one
    // replaced) matched only the last, so the first five went unseen.
    it.each([
      ['spawnSync', 'spawnSync(process.execPath, [\'scripts/eval-ask.mjs\', \'--only=sum\']);'],
      ['execFile', 'execFile(\'node\', [path.join(ROOT, \'scripts\', \'eval-ask.mjs\')], done);'],
      ['execFileSync', 'execFileSync(\'node\', [\'scripts/eval-ask.mjs\']);'],
      ['fork', 'fork(\'scripts/eval-ask.mjs\');'],
      ['a path held in a variable', 'const runner = path.join(ROOT, \'scripts\', \'eval-ask.mjs\');\nspawn(process.execPath, [runner]);'],
      ['a shell string', 'execSync(`node scripts/eval-ask.mjs`);'],
    ])('names the runner in %s', (_shape, source) => {
      expect(mentionsRunner(source)).toBe(true);
      expect(codeLinesNamingRunner(source).length).toBeGreaterThan(0);
    });

    it('does not take a comment citing the harness for code, and does take the same words as code', () => {
      expect(codeLinesNamingRunner('/**\n * MANUAL ONLY, like `eval-ask.mjs`.\n */\n// see eval-ask.mjs')).toEqual([]);
      expect(codeLinesNamingRunner('run(); // eval-ask.mjs')).toHaveLength(1);
    });

    it('lets an import through and nothing else', () => {
      expect(importsOnly('import { __testing } from \'../../scripts/eval-ask.mjs\';')).toBe(true);
      expect(importsOnly('const harness = await import(\'../../scripts/eval-ask.mjs\');')).toBe(true);
      expect(importsOnly('spawnSync(\'node\', [\'scripts/eval-ask.mjs\']);')).toBe(false);
      expect(importsOnly('import { __testing } from \'../../scripts/eval-ask.mjs\';\nfork(\'scripts/eval-ask.mjs\');')).toBe(false);
    });

    it('walks nested folders and reads .ts, .js and .mjs, and nothing else', () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-ask-scan-'));
      try {
        fs.mkdirSync(path.join(directory, 'deep', 'er'), { recursive: true });
        fs.writeFileSync(path.join(directory, 'top.ts'), 'fork(\'scripts/eval-ask.mjs\');');
        fs.writeFileSync(path.join(directory, 'deep', 'helper.js'), 'const runner = \'scripts/eval-ask.mjs\';');
        fs.writeFileSync(path.join(directory, 'deep', 'er', 'run.mjs'), 'spawnSync(\'node\', [\'scripts/eval-ask.mjs\']);');
        fs.writeFileSync(path.join(directory, 'deep', 'er', 'notes.json'), '{"note":"eval-ask"}');
        fs.writeFileSync(path.join(directory, 'clean.ts'), 'export const fine = 1;');

        const files = listFiles(directory, TEST_EXTENSIONS);
        const { scanned, offenders } = scanFiles(directory, 'fixture', files, mentionsRunner);

        expect(scanned.sort()).toEqual(['fixture/clean.ts', 'fixture/deep/er/run.mjs', 'fixture/deep/helper.js', 'fixture/top.ts']);
        expect(offenders.sort()).toEqual(['fixture/deep/er/run.mjs', 'fixture/deep/helper.js', 'fixture/top.ts']);
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    });
  });

  it('refuses to run when a CI environment variable is set', async () => {
    // The backstop for wiring this scan cannot see - a developer machine with
    // CI set, a runner this repo does not know about, a script invoked by path.
    const harness = await import('../../scripts/eval-ask.mjs');
    const previous = process.env.CI;
    process.env.CI = 'true';
    try {
      expect(() => harness.__testing.refuseIfAutomated(true)).toThrow(/Refusing to run/);
      // ...and the free modes stay usable, since they cost nothing.
      expect(() => harness.__testing.refuseIfAutomated(false)).not.toThrow();
    } finally {
      if (previous === undefined) delete process.env.CI;
      else process.env.CI = previous;
    }
  });
});
