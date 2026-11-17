#!/usr/bin/env node
/**
 * Decides which UI spec files each CI shard runs, by measured time instead of by test count.
 *
 * Playwright's own `--shard` cuts the suite into windows of equal test COUNT, in file order. A UI
 * test costs anywhere from under a second to 24, so on 2026-11-17 the eleven windows held 799 to
 * 1,675 test-seconds and the slowest shard set every PR's time to green. This assigns whole spec
 * files instead, heaviest first, each to the shard holding the least so far. On that run's timings
 * every shard comes out at 1,123 test-seconds.
 *
 * The weights are tests/ui/shard-timings.json, written from a CI run's own logs by
 * scripts/ui-shard-timings.mjs. A spec the file does not know yet is weighed by its test count, so
 * a new spec is never left out and a stale file only costs balance, never coverage.
 *
 * Usage:
 *   node scripts/ui-shard-plan.mjs 3/11          Prints shard 3's spec files, one a line, in the
 *                                                form Playwright's --test-list reads.
 *   node scripts/ui-shard-plan.mjs --verify 11   Fails unless the 11 shards together hold every
 *                                                test `playwright test --project=ui --list` finds.
 *
 * --verify is the guard that matters. --test-list matches a path exactly and reports no error
 * when a line matches nothing, so a plan Playwright cannot read would run no tests and pass.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntrypoint } from './lib/is-entrypoint.mjs';
import { resolvePlaywrightCli } from './lib/playwright-cli.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The UI tier's spec directory and the timings file, as repo-relative posix paths. */
export const UI_SPEC_DIRECTORY = 'tests/ui';
export const TIMINGS_FILE = 'tests/ui/shard-timings.json';

/** What a test costs when the timings file holds no test at all. Only a missing file reaches it. */
const FALLBACK_SECONDS_PER_TEST = 4;

/**
 * Every `*.spec.ts` under tests/ui, as sorted repo-relative posix paths. That is the form
 * Playwright's --test-list compares against (a path relative to the config's directory).
 */
export function listSpecFiles(repoRoot = REPO_ROOT) {
  const found = [];
  const walk = (relativeDirectory) => {
    for (const entry of fs.readdirSync(path.join(repoRoot, relativeDirectory), { withFileTypes: true })) {
      const relativePath = `${relativeDirectory}/${entry.name}`;
      if (entry.isDirectory()) walk(relativePath);
      else if (entry.name.endsWith('.spec.ts')) found.push(relativePath);
    }
  };
  walk(UI_SPEC_DIRECTORY);
  return found.sort();
}

/** How many tests a spec declares, counted from its source. A loop's body counts once. */
export function countDeclaredTests(source) {
  const declarations = source.match(/^\s*test(\.(only|fixme|skip|fail|slow))?\(/gm);
  return Math.max(1, declarations ? declarations.length : 0);
}

/** The timings file's contents, or an empty set when the file is missing. */
export function readTimings(repoRoot = REPO_ROOT) {
  const timingsPath = path.join(repoRoot, TIMINGS_FILE);
  if (!fs.existsSync(timingsPath)) return { files: {} };
  return JSON.parse(fs.readFileSync(timingsPath, 'utf8'));
}

/**
 * Each spec's weight in seconds: its measured time, or its test count times what a measured test
 * costs on average.
 *
 * @param {string[]} specFiles
 * @param {{ files: Record<string, { seconds: number, tests: number }> }} timings
 * @param {(specFile: string) => string} readSource
 * @returns {Array<{ file: string, seconds: number, measured: boolean }>}
 */
export function weighSpecs(specFiles, timings, readSource) {
  const measured = Object.values(timings.files);
  const measuredSeconds = measured.reduce((total, entry) => total + entry.seconds, 0);
  const measuredTests = measured.reduce((total, entry) => total + entry.tests, 0);
  const secondsPerTest = measuredTests > 0 ? measuredSeconds / measuredTests : FALLBACK_SECONDS_PER_TEST;
  return specFiles.map((file) => {
    const timing = timings.files[file];
    if (timing) return { file, seconds: timing.seconds, measured: true };
    return { file, seconds: countDeclaredTests(readSource(file)) * secondsPerTest, measured: false };
  });
}

/**
 * Assigns each spec to a shard: heaviest first, each to the shard holding the least so far. Ties
 * break on the path and on the lower shard, so every shard job computes the same plan from the
 * same tree.
 *
 * @param {Array<{ file: string, seconds: number }>} weighedSpecs
 * @param {number} shardTotal
 * @returns {Array<{ files: string[], seconds: number }>}
 */
export function planShards(weighedSpecs, shardTotal) {
  if (!Number.isInteger(shardTotal) || shardTotal < 1) {
    throw new Error(`The shard total must be a whole number of at least 1, not ${shardTotal}.`);
  }
  const shards = Array.from({ length: shardTotal }, () => ({ files: [], seconds: 0 }));
  const heaviestFirst = [...weighedSpecs].sort((first, second) =>
    second.seconds - first.seconds || (first.file < second.file ? -1 : first.file > second.file ? 1 : 0));
  for (const spec of heaviestFirst) {
    let lightest = shards[0];
    for (const shard of shards) {
      if (shard.seconds < lightest.seconds) lightest = shard;
    }
    lightest.files.push(spec.file);
    lightest.seconds += spec.seconds;
  }
  for (const shard of shards) shard.files.sort();
  return shards;
}

/** The plan for this checkout: every spec under tests/ui, weighed and assigned. */
export function planForRepo(shardTotal, repoRoot = REPO_ROOT) {
  const specFiles = listSpecFiles(repoRoot);
  const weighed = weighSpecs(specFiles, readTimings(repoRoot), (file) => fs.readFileSync(path.join(repoRoot, file), 'utf8'));
  return planShards(weighed, shardTotal);
}

/** Reads `3/11` into its two numbers, or throws naming what it got. */
export function parseShardArgument(argument) {
  const match = /^(\d+)\/(\d+)$/.exec(argument ?? '');
  if (!match) throw new Error(`Expected a shard as <index>/<total>, such as 3/11, not ${JSON.stringify(argument)}.`);
  const shardIndex = Number(match[1]);
  const shardTotal = Number(match[2]);
  if (shardIndex < 1 || shardIndex > shardTotal) {
    throw new Error(`Shard ${shardIndex} is outside 1 to ${shardTotal}.`);
  }
  return { shardIndex, shardTotal };
}

/** How many tests Playwright lists for the ui project, read from its `Total:` line. */
function listedTestCount(extraArguments) {
  const output = execFileSync(
    process.execPath,
    [resolvePlaywrightCli(), 'test', '--project=ui', '--list', ...extraArguments],
    { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const total = /^Total: (\d+) tests? in (\d+) files?$/m.exec(output);
  if (!total) throw new Error('Playwright printed no "Total:" line, so the listed tests cannot be counted.');
  return { tests: Number(total[1]), files: Number(total[2]) };
}

/**
 * Proves the plan against Playwright itself: the tests it lists through every shard's file list
 * are the tests it lists with no list at all.
 */
function verifyPlan(shardTotal) {
  const shards = planForRepo(shardTotal);
  const planned = shards.flatMap((shard) => shard.files);
  const repeated = planned.filter((file, index) => planned.indexOf(file) !== index);
  if (repeated.length > 0) throw new Error(`These specs are in more than one shard: ${repeated.join(', ')}`);
  const emptyShards = shards.flatMap((shard, index) => (shard.files.length === 0 ? [index + 1] : []));
  if (emptyShards.length > 0) throw new Error(`These shards hold no spec: ${emptyShards.join(', ')}`);

  const listDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-shard-plan-'));
  try {
    const listPath = path.join(listDirectory, 'every-shard.txt');
    fs.writeFileSync(listPath, `${planned.join('\n')}\n`);
    const everything = listedTestCount([]);
    const throughThePlan = listedTestCount([`--test-list=${listPath}`]);
    if (everything.tests === 0) throw new Error('Playwright lists no UI test at all.');
    if (everything.tests !== throughThePlan.tests || everything.files !== throughThePlan.files) {
      throw new Error(
        `The ${shardTotal} shards together run ${throughThePlan.tests} tests in ${throughThePlan.files} files, `
        + `but the ui project has ${everything.tests} in ${everything.files}. A spec the plan does not reach is never tested.`,
      );
    }
    console.log(`[ui-shard-plan] ${shardTotal} shards cover all ${everything.tests} UI tests in ${everything.files} files.`);
  } finally {
    fs.rmSync(listDirectory, { recursive: true, force: true });
  }
}

function main() {
  const [first, second] = process.argv.slice(2);
  if (first === '--verify') {
    verifyPlan(Number(second));
    return;
  }
  const { shardIndex, shardTotal } = parseShardArgument(first);
  const shard = planForRepo(shardTotal)[shardIndex - 1];
  if (shard.files.length === 0) {
    throw new Error(`Shard ${shardIndex}/${shardTotal} holds no spec, and a run with nothing in it would pass.`);
  }
  console.error(`[ui-shard-plan] shard ${shardIndex}/${shardTotal}: ${shard.files.length} specs, about ${Math.round(shard.seconds)} test-seconds`);
  process.stdout.write(`${shard.files.join('\n')}\n`);
}

if (isEntrypoint(import.meta.url)) {
  main();
}
