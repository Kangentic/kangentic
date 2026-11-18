/**
 * The verdict of an agent CLI rig run (scripts/probe-ssh-rig/transcript-summary.mjs), which
 * .github/workflows/agent-clis.yml runs every night against the newest release of each CLI.
 *
 * What the team loses if it breaks: the nightly reads green while testing nothing. The real-CLI test
 * file skips itself without its gate variable and vitest exits 0 with every test skipped, and a CLI
 * whose installer failed has no version to name. Each case here is one way a run is not a pass.
 *
 * Tier: Unit. It imports the script's own decision and feeds it reports in vitest's JSON shape.
 */
import { describe, expect, it } from 'vitest';
import { assertionsOf, parseVersions, summarize } from '../../scripts/probe-ssh-rig/transcript-summary.mjs';

const VERSIONS = ['Kimi\tkimi-code 2.5.1', 'Codex\tcodex-cli 0.171.0', 'OpenCode 1\t1.19.5', 'OpenCode 2\t2.2.5', ''].join('\n');

interface ReportedTest {
  title: string;
  status: string;
  failureMessages?: string[];
}

function reportOf(tests: ReportedTest[]): unknown {
  return {
    numTotalTests: tests.length,
    testResults: [{ name: 'tests/unit/remote-transcript-real-cli.test.ts', assertionResults: tests.map((test) => ({ failureMessages: [], ...test })) }],
  };
}

const ALL_PASSED: ReportedTest[] = [
  { title: 'Kimi: a fresh session is found from the index, and its conversation arrives', status: 'passed' },
  { title: 'Codex: a search finds the rollout when the id arrives late', status: 'passed' },
  { title: 'OpenCode 1: an id that arrives late starts the export, and it arrives', status: 'passed' },
  { title: 'OpenCode 2: an id that arrives late starts the export, and it arrives', status: 'passed' },
];

describe('the agent CLI rig summary', () => {
  it('reads the versions file, one CLI per line, with a tab between name and version', () => {
    expect(parseVersions(VERSIONS)).toEqual([
      { name: 'Kimi', version: 'kimi-code 2.5.1' },
      { name: 'Codex', version: 'codex-cli 0.171.0' },
      { name: 'OpenCode 1', version: '1.19.5' },
      { name: 'OpenCode 2', version: '2.2.5' },
    ]);
  });

  it('passes a run where every CLI installed and every test passed', () => {
    const { rows, problems } = summarize({ versionsText: VERSIONS, report: reportOf(ALL_PASSED) });
    expect(problems).toEqual([]);
    expect(rows.map((row) => row.result)).toEqual(['passed', 'passed', 'passed', 'passed']);
  });

  it('gives a test only to the CLI its title starts with', () => {
    // "OpenCode 1" must not take "OpenCode 2"'s test, and the reverse.
    const tests = ALL_PASSED.map((test) => (test.title.startsWith('OpenCode 2:') ? { ...test, status: 'failed', failureMessages: ['expected 1 to be 2'] } : test));
    const { rows, problems } = summarize({ versionsText: VERSIONS, report: reportOf(tests) });
    expect(rows.map((row) => `${row.name}=${row.result}`)).toEqual(['Kimi=passed', 'Codex=passed', 'OpenCode 1=passed', 'OpenCode 2=failed']);
    expect(problems).toEqual(['OpenCode 2 2.2.5: failed, expected 1 to be 2']);
  });

  it('fails a run whose tests were all skipped, which vitest itself exits 0 on', () => {
    const skipped = ALL_PASSED.map((test) => ({ ...test, status: 'skipped' }));
    const { rows, problems } = summarize({ versionsText: VERSIONS, report: reportOf(skipped) });
    // One line says it, and the rows still show each CLI as skipped.
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('All 4 tests were skipped');
    expect(rows.map((row) => row.result)).toEqual(['skipped', 'skipped', 'skipped', 'skipped']);
  });

  it('names one skipped test among tests that ran', () => {
    const tests = ALL_PASSED.map((test) => (test.title.startsWith('Kimi:') ? { ...test, status: 'skipped' } : test));
    const { problems } = summarize({ versionsText: VERSIONS, report: reportOf(tests) });
    expect(problems).toEqual(['Kimi kimi-code 2.5.1: skipped, its test did not run']);
  });

  it('names the CLI and the version a failed test ran against, with the first line of the failure', () => {
    const tests = ALL_PASSED.map((test) =>
      test.title.startsWith('Codex:')
        ? { ...test, status: 'failed', failureMessages: ['\u001b[31mAssertionError: files matching /rollout-.*\\.jsonl$/\u001b[39m\n    at hostFileUnder'] }
        : test,
    );
    const { problems } = summarize({ versionsText: VERSIONS, report: reportOf(tests) });
    expect(problems).toEqual(['Codex codex-cli 0.171.0: failed, AssertionError: files matching /rollout-.*\\.jsonl$/']);
  });

  it('fails a CLI that did not install, and says so without a version', () => {
    const versions = VERSIONS.replace('Codex\tcodex-cli 0.171.0', 'Codex\tnot installed');
    const { rows, problems } = summarize({ versionsText: versions, report: reportOf(ALL_PASSED) });
    expect(rows.find((row) => row.name === 'Codex')?.result).toBe('not installed');
    expect(problems).toEqual(['Codex: not installed, it did not print a version']);
  });

  it('fails a CLI that has a version and no test', () => {
    const { problems } = summarize({ versionsText: `${VERSIONS}Gemini\t0.67.0\n`, report: reportOf(ALL_PASSED) });
    expect(problems).toEqual(['Gemini 0.67.0: no test, no test title starts with "Gemini:"']);
  });

  it('fails a test whose CLI recorded no version', () => {
    const tests = [...ALL_PASSED, { title: 'Droid: its SessionStart hook reaches this computer', status: 'passed' }];
    const { problems } = summarize({ versionsText: VERSIONS, report: reportOf(tests) });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('"Droid: its SessionStart hook reaches this computer" names no CLI in the versions file');
  });

  it('fails when either file is missing or empty', () => {
    expect(summarize({ versionsText: null, report: reportOf(ALL_PASSED) }).problems[0]).toContain('The versions file is missing');
    expect(summarize({ versionsText: '', report: reportOf(ALL_PASSED) }).problems[0]).toContain('The versions file is empty');
    expect(summarize({ versionsText: VERSIONS, report: null }).problems).toEqual(['The test report is missing, so the tests did not run.']);
    expect(summarize({ versionsText: VERSIONS, report: reportOf([]) }).problems[0]).toBe('The test report holds no tests.');
  });

  it('reads a report of any shape without throwing', () => {
    expect(assertionsOf(null)).toEqual([]);
    expect(assertionsOf({ testResults: 'nope' })).toEqual([]);
    expect(assertionsOf({ testResults: [null, { assertionResults: [null, { title: 7 }] }] })).toEqual([
      { title: '', status: '', failureMessages: [] },
      { title: '', status: '', failureMessages: [] },
    ]);
  });
});
