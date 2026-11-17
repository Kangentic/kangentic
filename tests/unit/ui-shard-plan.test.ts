import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import {
  TIMINGS_FILE,
  countDeclaredTests,
  listSpecFiles,
  parseShardArgument,
  planForRepo,
  planShards,
  readTimings,
  weighSpecs,
} from '../../scripts/ui-shard-plan.mjs';
import { addShardLog, formatTimings } from '../../scripts/ui-shard-timings.mjs';
import { readWorkflow } from './helpers/read-workflow';

// CI's UI shards run the spec files scripts/ui-shard-plan.mjs hands them, not Playwright's own
// --shard windows. A spec the plan leaves out is a spec no shard runs, and Playwright's --test-list
// reports nothing when a line matches no file. So what a user loses if this goes is a UI test that
// stops running with every check still green. Tier: Unit.

const REPO_ROOT = path.resolve(__dirname, '../..');

interface PlannedShard {
  files: string[];
  seconds: number;
}

function shardLegs(ciSource: string, jobId: string): number {
  const start = ciSource.indexOf(`\n  ${jobId}:\n`);
  if (start === -1) throw new Error(`ci.yml has no ${jobId} job.`);
  const matrix = /^ {8}shardIndex: \[([^\]]*)\]$/m.exec(ciSource.slice(start));
  if (!matrix) throw new Error(`The ${jobId} job has no shardIndex matrix at the indentation this reads.`);
  return matrix[1].split(',').filter((item) => item.trim() !== '').length;
}

describe('planShards', () => {
  it('puts every spec in exactly one shard', () => {
    const weighed = Array.from({ length: 40 }, (_, index) => ({ file: `tests/ui/spec-${index}.spec.ts`, seconds: (index * 37) % 23 + 1 }));
    const shards: PlannedShard[] = planShards(weighed, 7);
    expect(shards).toHaveLength(7);
    expect(shards.flatMap((shard) => shard.files).sort()).toEqual(weighed.map((spec) => spec.file).sort());
  });

  it('balances by seconds, where equal counts would not', () => {
    // Four heavy specs and twelve light ones. Cut by count into four, one shard would take all four
    // heavy specs; by weight each shard takes one.
    const heavy = Array.from({ length: 4 }, (_, index) => ({ file: `tests/ui/a-heavy-${index}.spec.ts`, seconds: 300 }));
    const light = Array.from({ length: 12 }, (_, index) => ({ file: `tests/ui/b-light-${index}.spec.ts`, seconds: 10 }));
    const shards: PlannedShard[] = planShards([...heavy, ...light], 4);
    expect(shards.map((shard) => shard.seconds)).toEqual([330, 330, 330, 330]);
    for (const shard of shards) {
      expect(shard.files.filter((file) => file.includes('a-heavy-'))).toHaveLength(1);
    }
  });

  it('gives the same plan whatever order the specs arrive in', () => {
    const weighed = Array.from({ length: 30 }, (_, index) => ({ file: `tests/ui/spec-${index}.spec.ts`, seconds: (index % 5) + 1 }));
    const forwards: PlannedShard[] = planShards(weighed, 4);
    const backwards: PlannedShard[] = planShards([...weighed].reverse(), 4);
    expect(backwards).toEqual(forwards);
  });

  it('refuses a shard total that is not a whole number of at least one', () => {
    expect(() => planShards([], 0)).toThrow('shard total');
    expect(() => planShards([], Number.NaN)).toThrow('shard total');
  });
});

describe('weighSpecs', () => {
  const timings = { files: { 'tests/ui/known.spec.ts': { seconds: 90, tests: 30 } } };

  it('weighs a measured spec by its measured seconds', () => {
    const [known] = weighSpecs(['tests/ui/known.spec.ts'], timings, () => '');
    expect(known).toEqual({ file: 'tests/ui/known.spec.ts', seconds: 90, measured: true });
  });

  it('weighs a spec the timings do not know by its test count, so a new spec is still planned', () => {
    const source = "test('one', async () => {});\n  test.skip('two', async () => {});\n";
    const [unknown] = weighSpecs(['tests/ui/new.spec.ts'], timings, () => source);
    // Two tests at the measured average of three seconds a test.
    expect(unknown).toEqual({ file: 'tests/ui/new.spec.ts', seconds: 6, measured: false });
  });

  it('weighs an unmeasured spec at four seconds a test when the timings hold no test at all', () => {
    const source = "test('one', async () => {});\n  test('two', async () => {});\n  test('three', async () => {});\n";
    const [unknown] = weighSpecs(['tests/ui/new.spec.ts'], { files: {} }, () => source);
    expect(unknown).toEqual({ file: 'tests/ui/new.spec.ts', seconds: 12, measured: false });
  });

  it('reads no timings, rather than failing, from a checkout without the timings file', () => {
    const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-shard-plan-'));
    try {
      expect(readTimings(emptyRoot)).toEqual({ files: {} });
    } finally {
      fs.rmSync(emptyRoot, { recursive: true, force: true });
    }
  });

  it('counts a spec with no test declaration as one test, never as weightless', () => {
    expect(countDeclaredTests('// generated in a loop elsewhere\n')).toBe(1);
    expect(countDeclaredTests("test.describe('group', () => {\n  test('inner', async () => {});\n});\n")).toBe(1);
  });
});

describe('parseShardArgument', () => {
  it('reads an index and a total', () => {
    expect(parseShardArgument('3/11')).toEqual({ shardIndex: 3, shardTotal: 11 });
  });

  it.each(['', '3', '0/11', '12/11', 'a/b', undefined])('refuses %s', (argument) => {
    expect(() => parseShardArgument(argument)).toThrow();
  });
});

describe('the plan for this repository', () => {
  const specFiles: string[] = listSpecFiles(REPO_ROOT);
  const ciSource = readWorkflow('ci.yml');
  const uiShardTotal = shardLegs(ciSource, 'playwright-shards');

  it('finds the UI specs (proves the walk still matches)', () => {
    expect(specFiles.length).toBeGreaterThan(100);
    expect(specFiles).toContain('tests/ui/app.spec.ts');
    expect(specFiles.every((file) => file.startsWith('tests/ui/') && file.endsWith('.spec.ts'))).toBe(true);
  });

  it('assigns every spec on disk to exactly one of the shards CI runs, and leaves no shard empty', () => {
    const shards: PlannedShard[] = planForRepo(uiShardTotal, REPO_ROOT);
    expect(shards).toHaveLength(uiShardTotal);
    expect(shards.flatMap((shard) => shard.files).sort()).toEqual(specFiles);
    expect(shards.filter((shard) => shard.files.length === 0)).toEqual([]);
  });

  it('holds no spec heavier than an average shard, which file-level balancing cannot split', () => {
    const timings = readTimings(REPO_ROOT);
    const weighed = weighSpecs(specFiles, timings, (file: string) => fs.readFileSync(path.join(REPO_ROOT, file), 'utf8'));
    const total = weighed.reduce((sum: number, spec: { seconds: number }) => sum + spec.seconds, 0);
    const averageShard = total / uiShardTotal;
    const tooHeavy = weighed.filter((spec: { seconds: number }) => spec.seconds > averageShard);
    expect(
      tooHeavy,
      `A spec this heavy sets its shard's time alone. Split it into two spec files, then refresh ${TIMINGS_FILE}.`,
    ).toEqual([]);
  });

  it('keeps the heaviest shard within a tenth of the average on the committed timings', () => {
    const shards: PlannedShard[] = planForRepo(uiShardTotal, REPO_ROOT);
    const seconds = shards.map((shard) => shard.seconds);
    const average = seconds.reduce((sum, value) => sum + value, 0) / seconds.length;
    expect(Math.max(...seconds)).toBeLessThanOrEqual(average * 1.1);
  });

  it('has timings for the specs, in the path form the plan compares', () => {
    const timings = readTimings(REPO_ROOT);
    const timedFiles = Object.keys(timings.files);
    expect(timedFiles.length).toBeGreaterThan(100);
    expect(timedFiles.every((file) => /^tests\/ui\/[\w./-]+\.spec\.ts$/.test(file))).toBe(true);
    // Most specs on disk are measured. A file that matches none would weigh every spec by count.
    const measuredOnDisk = specFiles.filter((file) => timings.files[file] !== undefined);
    expect(measuredOnDisk.length).toBeGreaterThan(specFiles.length * 0.5);
  });
});

describe('ci.yml runs the plan', () => {
  const ciSource = readWorkflow('ci.yml');

  it('plans each UI shard from its own matrix values and hands Playwright the list', () => {
    expect(ciSource).toContain('node scripts/ui-shard-plan.mjs ${{ matrix.shardIndex }}/${{ matrix.shardTotal }} > "$RUNNER_TEMP/ui-shard-files.txt"');
    expect(ciSource).toContain('npx playwright test --project=ui --test-list="$RUNNER_TEMP/ui-shard-files.txt" --fail-on-flaky-tests');
  });

  it('no longer cuts the UI tier with --shard, which would run a window of the list and drop the rest', () => {
    const uiRun = ciSource.split('\n').find((line) => line.includes('playwright test --project=ui'));
    expect(uiRun).toBeDefined();
    expect(uiRun).not.toContain('--shard');
  });

  it('proves the plan against Playwright for the shard total the matrix runs', () => {
    const uiShardTotal = shardLegs(ciSource, 'playwright-shards');
    expect(ciSource).toContain(`node scripts/ui-shard-plan.mjs --verify ${uiShardTotal}\n`);
  });
});

// The demo tier keeps Playwright's --shard, since nearly all of it is one spec file, and levels its
// halves with an environment variable Playwright does not document. If an upgrade stops reading it,
// the weights do nothing and one half quietly runs twice as long as the other.
describe('ci.yml weights the web demo shards', () => {
  const ciSource = readWorkflow('ci.yml');

  it('sets one weight per demo shard', () => {
    const start = ciSource.indexOf('\n  demo-shards:\n');
    expect(start).toBeGreaterThan(-1);
    const job = ciSource.slice(start, ciSource.indexOf('\n  demo:\n', start));
    const weights = /^ {6}PWTEST_SHARD_WEIGHTS: '([\d:]+)'$/m.exec(job);
    expect(weights, 'The demo-shards job no longer sets PWTEST_SHARD_WEIGHTS.').not.toBeNull();
    // Playwright throws when the weights and the shard total disagree, which fails both shards.
    expect(weights?.[1].split(':')).toHaveLength(shardLegs(ciSource, 'demo-shards'));
    expect(job).toContain('npm run test:demo -- --shard=${{ matrix.shardIndex }}/${{ matrix.shardTotal }}');
  });

  it('keeps the demo spec free of a file-level beforeAll, which fixes the cut at its midpoint', () => {
    // Playwright cuts the tests under a beforeAll into as many whole groups as there are shards
    // (createTestGroups, parallelWithHooks), so with one at the top of this file the two shards
    // took 156 tests each whatever the weights said: 410 test-seconds against 812. The spec cannot
    // be imported here, since importing it declares its tests, so this reads its text.
    const demoSpec = fs.readFileSync(path.join(REPO_ROOT, 'tests', 'demo', 'static-demo.spec.ts'), 'utf8');
    expect(demoSpec).not.toMatch(/^test\.(beforeAll|afterAll)\(/m);
    expect(demoSpec, 'The demo spec no longer starts its server from a worker fixture.').toMatch(/scope: 'worker', auto: true/);
  });

  it('runs on a Playwright that still reads the weights', () => {
    const requireFromHere = createRequire(import.meta.url);
    const packageDirectory = path.dirname(requireFromHere.resolve('playwright/package.json'));
    const readers = ['lib/cli/testActions.js', 'lib/runner/index.js', 'lib/program.js']
      .map((file) => path.join(packageDirectory, file))
      .filter((file) => fs.existsSync(file))
      .filter((file) => fs.readFileSync(file, 'utf8').includes('process.env.PWTEST_SHARD_WEIGHTS'));
    expect(
      readers.length,
      'The installed Playwright no longer reads PWTEST_SHARD_WEIGHTS, so the demo shards are cut evenly by count again. '
      + 'Re-balance them another way, or drop the variable from ci.yml.',
    ).toBeGreaterThan(0);
  });
});

describe('reading a shard log', () => {
  it('sums seconds and tests per spec across units, and skips every other line', () => {
    const log = [
      'UI Test (3/11)\tUNKNOWN STEP\t2026-11-17T17:20:00.0000000Z   ✓    1 [ui] › tests/ui/first.spec.ts:10:3 › group › opens (2.5s)',
      'UI Test (3/11)\tUNKNOWN STEP\t2026-11-17T17:20:01.0000000Z   ✓    2 [ui] › tests/ui/first.spec.ts:20:3 › group › closes (500ms)',
      'UI Test (3/11)\tUNKNOWN STEP\t2026-11-17T17:20:02.0000000Z   ✓    3 [ui] › tests/ui/second.spec.ts:5:1 › slow one (1.1m)',
      'UI Test (3/11)\tUNKNOWN STEP\t2026-11-17T17:20:03.0000000Z Running 3 tests using 3 workers',
      'UI Test (3/11)\tUNKNOWN STEP\t2026-11-17T17:20:04.0000000Z   3 passed (1.2m)',
    ].join('\r\n');
    const files = addShardLog(log);
    expect(files['tests/ui/first.spec.ts']).toEqual({ seconds: 3, tests: 2 });
    expect(files['tests/ui/second.spec.ts'].tests).toBe(1);
    expect(files['tests/ui/second.spec.ts'].seconds).toBeCloseTo(66);
    expect(Object.keys(files)).toHaveLength(2);
  });

  it('counts a failed test and each retry of it, and counts a skipped test for nothing', () => {
    // Line shapes are Playwright's list reporter, as printed by its _updateTestLine: a failed test
    // ends in " (<duration>)", a retry puts " (retry #N)" before that duration, and a skipped test
    // has no duration at all.
    const prefix = 'UI Test (3/11)\tUNKNOWN STEP\t2026-11-17T17:20:00.0000000Z';
    const log = [
      `${prefix}   ✘    1 [ui] › tests/ui/flaky.spec.ts:10:3 › group › fails first (2s)`,
      `${prefix}   ✓    2 [ui] › tests/ui/flaky.spec.ts:10:3 › group › fails first (retry #1) (3s)`,
      `${prefix}   -    3 [ui] › tests/ui/flaky.spec.ts:30:3 › group › skipped one`,
      `${prefix}   -    4 [ui] › tests/ui/skipper.spec.ts:5:1 › skipped alone (retry #1)`,
    ].join('\n');
    const files = addShardLog(log);
    // Both runs of the retried test were paid for by the shard, so both are in.
    expect(files['tests/ui/flaky.spec.ts']).toEqual({ seconds: 5, tests: 2 });
    // A spec that only skipped has no measured cost, so it stays out and is weighed by its count.
    expect(files['tests/ui/skipper.spec.ts']).toBeUndefined();
  });

  it('writes paths sorted and seconds rounded, so a refresh diffs cleanly', () => {
    const written = JSON.parse(formatTimings(7, {
      'tests/ui/b.spec.ts': { seconds: 1.26, tests: 1 },
      'tests/ui/a.spec.ts': { seconds: 2, tests: 3 },
    }));
    expect(written.run).toBe(7);
    expect(Object.keys(written.files)).toEqual(['tests/ui/a.spec.ts', 'tests/ui/b.spec.ts']);
    expect(written.files['tests/ui/b.spec.ts']).toEqual({ seconds: 1.3, tests: 1 });
  });
});
