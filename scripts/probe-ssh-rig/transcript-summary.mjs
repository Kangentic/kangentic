#!/usr/bin/env node
/**
 * The verdict of one agent CLI rig run (.github/workflows/agent-clis.yml).
 *
 * It joins two files the run leaves behind: the versions scripts/probe-ssh-rig/transcript-clis.sh
 * recorded ("<name><TAB><version>" per CLI) and vitest's JSON report of
 * tests/unit/remote-transcript-real-cli.test.ts. A test belongs to the CLI its title starts with
 * ("Codex: a search finds the rollout..."), so a red row names the CLI and the version it ran.
 *
 * It exits 1 unless every CLI installed, every test ran, and every test passed. That matters because
 * the test file skips itself without KANGENTIC_TRANSCRIPT_RIG and vitest then exits 0 with eight tests
 * skipped: a run that tested nothing must not read as a pass.
 *
 * Usage: node scripts/probe-ssh-rig/transcript-summary.mjs --versions <file> --results <file>
 * In GitHub Actions it also writes the step summary and one annotation per problem.
 */
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

/** What transcript-clis.sh records for a CLI whose `--version` failed. */
const NOT_INSTALLED = 'not installed';

/**
 * @typedef {{ name: string, version: string }} CliVersion
 * @typedef {{ title: string, status: string, failureMessages: string[] }} Assertion
 * @typedef {{ name: string, version: string, result: 'passed' | 'failed' | 'skipped' | 'no test' | 'not installed', detail: string }} Row
 */

/**
 * @param {string} text The versions file.
 * @returns {CliVersion[]}
 */
export function parseVersions(text) {
  return text
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const tab = line.indexOf('\t');
      return tab === -1 ? { name: line.trim(), version: '' } : { name: line.slice(0, tab).trim(), version: line.slice(tab + 1).trim() };
    });
}

/**
 * Every test in a vitest JSON report, whatever file it came from.
 *
 * @param {unknown} report
 * @returns {Assertion[]}
 */
export function assertionsOf(report) {
  const files = report !== null && typeof report === 'object' && Array.isArray(/** @type {{ testResults?: unknown }} */ (report).testResults)
    ? /** @type {{ testResults: unknown[] }} */ (report).testResults
    : [];
  return files.flatMap((file) => {
    const results = file !== null && typeof file === 'object' ? /** @type {{ assertionResults?: unknown }} */ (file).assertionResults : undefined;
    if (!Array.isArray(results)) return [];
    return results.map((entry) => {
      const assertion = /** @type {{ title?: unknown, status?: unknown, failureMessages?: unknown }} */ (entry ?? {});
      return {
        title: typeof assertion.title === 'string' ? assertion.title : '',
        status: typeof assertion.status === 'string' ? assertion.status : '',
        failureMessages: Array.isArray(assertion.failureMessages) ? assertion.failureMessages.filter((message) => typeof message === 'string') : [],
      };
    });
  });
}

/** A terminal color code, built from its character code so no control character sits in this file. */
const COLOR_CODE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

/** The first line of a failure that says something, without vitest's color codes. */
function firstLine(messages) {
  const text = messages.join('\n').replace(COLOR_CODE, '');
  return text.split('\n').map((line) => line.trim()).find((line) => line !== '') ?? 'the test failed with no message';
}

/**
 * The decision, apart from the files and the printing, so each way a run can fail to be a pass is
 * unit-tested (tests/unit/transcript-summary.test.ts).
 *
 * @param {{ versionsText: string | null, report: unknown }} input `versionsText` is null when the
 *   versions file is missing, and `report` is null when the report is.
 * @returns {{ rows: Row[], problems: string[] }}
 */
export function summarize({ versionsText, report }) {
  /** @type {string[]} */
  const problems = [];
  const versions = versionsText === null ? [] : parseVersions(versionsText);
  if (versionsText === null) {
    problems.push('The versions file is missing, so the install step did not get as far as recording one.');
  } else if (versions.length === 0) {
    problems.push('The versions file is empty, so no CLI was installed.');
  }

  const assertions = report === null ? [] : assertionsOf(report);
  if (report === null) {
    problems.push('The test report is missing, so the tests did not run.');
  } else if (assertions.length === 0) {
    problems.push('The test report holds no tests.');
  }

  const belongsTo = (assertion, name) => assertion.title.startsWith(`${name}:`);
  const notRun = assertions.filter((assertion) => assertion.status !== 'passed' && assertion.status !== 'failed');
  if (assertions.length > 0 && notRun.length === assertions.length) {
    problems.push(`All ${assertions.length} tests were skipped, so nothing ran. The test file skips itself unless KANGENTIC_TRANSCRIPT_RIG is 1.`);
  }

  /** @type {Row[]} */
  const rows = versions.map(({ name, version }) => {
    const own = assertions.filter((assertion) => belongsTo(assertion, name));
    const failed = own.filter((assertion) => assertion.status === 'failed');
    if (version === NOT_INSTALLED) {
      return { name, version, result: 'not installed', detail: 'it did not print a version' };
    }
    if (own.length === 0) {
      return report === null
        ? { name, version, result: 'skipped', detail: 'the tests did not run' }
        : { name, version, result: 'no test', detail: `no test title starts with "${name}:"` };
    }
    if (failed.length > 0) {
      return { name, version, result: 'failed', detail: firstLine(failed.flatMap((assertion) => assertion.failureMessages)) };
    }
    if (own.some((assertion) => assertion.status !== 'passed')) {
      return { name, version, result: 'skipped', detail: 'its test did not run' };
    }
    return { name, version, result: 'passed', detail: `${own.length} test${own.length === 1 ? '' : 's'}` };
  });
  for (const row of rows) {
    if (row.result === 'passed') continue;
    // A missing report is already one problem. Each row repeating it would bury that line.
    if (report === null && row.result === 'skipped') continue;
    const label = row.version === NOT_INSTALLED || row.version === '' ? row.name : `${row.name} ${row.version}`;
    problems.push(`${label}: ${row.result}, ${row.detail}`);
  }

  for (const assertion of assertions) {
    if (!versions.some(({ name }) => belongsTo(assertion, name))) {
      problems.push(`The test "${assertion.title}" names no CLI in the versions file, so its version was never recorded. Add a record_version line for it to transcript-clis.sh.`);
    }
  }
  return { rows, problems };
}

function readOrNull(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function argument(argv, flag) {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

function main(argv) {
  const versionsFile = argument(argv, '--versions');
  const resultsFile = argument(argv, '--results');
  if (!versionsFile || !resultsFile) {
    console.error('Usage: node scripts/probe-ssh-rig/transcript-summary.mjs --versions <file> --results <file>');
    return 1;
  }
  const reportText = readOrNull(resultsFile);
  let report = null;
  let unreadable = null;
  if (reportText !== null) {
    try {
      report = JSON.parse(reportText);
    } catch (error) {
      unreadable = `The test report is not JSON: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  const { rows, problems } = summarize({ versionsText: readOrNull(versionsFile), report });
  if (unreadable) problems.unshift(unreadable);

  for (const row of rows) {
    console.log(`${row.result.padEnd(15)}${row.name.padEnd(12)}${row.version.padEnd(28)}${row.detail}`);
  }
  if (process.env.GITHUB_ACTIONS === 'true') {
    for (const problem of problems) console.log(`::error title=Agent CLIs::${problem}`);
    if (process.env.GITHUB_STEP_SUMMARY) {
      const cell = (text) => text.replace(/\|/g, '\\|');
      const lines = [
        '## Agent CLIs at their newest versions',
        '',
        '| Result | CLI | Version | Detail |',
        '| --- | --- | --- | --- |',
        ...rows.map((row) => `| ${row.result} | ${cell(row.name)} | ${cell(row.version)} | ${cell(row.detail)} |`),
        '',
        ...(problems.length > 0 ? ['Problems:', '', ...problems.map((problem) => `- ${problem}`), ''] : []),
      ];
      fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n'));
    }
  }
  if (problems.length > 0) {
    console.error(`\n${problems.length} problem${problems.length === 1 ? '' : 's'}:`);
    for (const problem of problems) console.error(`  - ${problem}`);
    return 1;
  }
  console.log(`\nAll ${rows.length} CLIs installed, ran and passed.`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
