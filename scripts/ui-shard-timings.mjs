#!/usr/bin/env node
/**
 * Writes tests/ui/shard-timings.json from one CI run: what each UI spec file cost in seconds and
 * how many tests it ran. scripts/ui-shard-plan.mjs balances the UI shards on it.
 *
 * The numbers come from the run's own UI shard logs. CI's `list` reporter prints a line per test
 * with its duration, so no report artifact is needed. A test that was retried counts both runs,
 * which is what the shard paid.
 *
 * Usage: node scripts/ui-shard-timings.mjs <run-id>
 *
 * Pick a green run where you can: a run with a red shard is accepted with a warning, and one with
 * a cancelled or timed-out shard is refused. It needs the `gh` CLI signed in to this repository.
 * Refresh it when one UI shard runs about 25% past the average (docs/audits/test-suite-audit.md,
 * "When to revisit"). A stale file costs balance only: a spec it does not know is weighed by its
 * test count.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntrypoint } from './lib/is-entrypoint.mjs';
import { TIMINGS_FILE } from './ui-shard-plan.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** A UI shard's job name in ci.yml, such as `UI Test (3/11)`. */
const UI_SHARD_JOB_NAME = /^UI Test \(\d+\/\d+\)$/;

/** One `list` reporter line: the spec path, then the title, then the duration in parentheses. */
const TEST_RESULT_LINE = /(tests\/ui\/\S+?\.spec\.ts):\d+:\d+ .*\((\d+(?:\.\d+)?)(ms|s|m)\)\s*$/;

const SECONDS_PER_UNIT = { ms: 0.001, s: 1, m: 60 };

/**
 * Sums a shard log into seconds and test count per spec file.
 *
 * @param {string} log
 * @param {Record<string, { seconds: number, tests: number }>} [into]
 */
export function addShardLog(log, into = {}) {
  for (const line of log.split('\n')) {
    const result = TEST_RESULT_LINE.exec(line);
    if (!result) continue;
    const entry = into[result[1]] ?? (into[result[1]] = { seconds: 0, tests: 0 });
    entry.seconds += Number(result[2]) * SECONDS_PER_UNIT[result[3]];
    entry.tests += 1;
  }
  return into;
}

/** The timings file's contents: paths sorted and seconds rounded, so a refresh diffs cleanly. */
export function formatTimings(runId, files) {
  const sorted = Object.fromEntries(
    Object.keys(files).sort().map((file) => [file, { seconds: Math.round(files[file].seconds * 10) / 10, tests: files[file].tests }]),
  );
  return `${JSON.stringify({ run: runId, files: sorted }, null, 2)}\n`;
}

function gh(githubArguments) {
  return execFileSync('gh', githubArguments, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
}

function main() {
  const runId = process.argv[2];
  if (!/^\d+$/.test(runId ?? '')) {
    throw new Error('Usage: node scripts/ui-shard-timings.mjs <run-id>');
  }
  const jobs = JSON.parse(gh(['run', 'view', runId, '--json', 'jobs'])).jobs;
  const shardJobs = jobs.filter((job) => UI_SHARD_JOB_NAME.test(job.name));
  if (shardJobs.length === 0) throw new Error(`Run ${runId} has no UI shard job.`);
  // A shard that failed still ran every test it was given, so its log is whole. One that was
  // cancelled or timed out stopped part way, and its specs would read as cheap.
  const partial = shardJobs.filter((job) => job.conclusion !== 'success' && job.conclusion !== 'failure').map((job) => job.name);
  if (partial.length > 0) {
    throw new Error(`Run ${runId} has UI shards that did not run to the end, so its timings are partial: ${partial.join(', ')}`);
  }
  const red = shardJobs.filter((job) => job.conclusion === 'failure').map((job) => job.name);
  if (red.length > 0) {
    console.warn(`[ui-shard-timings] ${red.join(', ')} failed. A failed test is retried once, so its spec reads a little heavy.`);
  }

  const files = {};
  for (const job of shardJobs) {
    addShardLog(gh(['run', 'view', '--job', String(job.databaseId), '--log']), files);
  }
  const specCount = Object.keys(files).length;
  if (specCount === 0) throw new Error(`Run ${runId}'s UI shard logs hold no test result line.`);

  // sync-write-ok: a dev script run by hand, writing one committed file in the repo.
  fs.writeFileSync(path.join(REPO_ROOT, TIMINGS_FILE), formatTimings(Number(runId), files));
  const totalSeconds = Object.values(files).reduce((total, entry) => total + entry.seconds, 0);
  console.log(`[ui-shard-timings] ${specCount} specs, ${Math.round(totalSeconds)} test-seconds from ${shardJobs.length} shards of run ${runId}.`);
}

if (isEntrypoint(import.meta.url)) {
  main();
}
