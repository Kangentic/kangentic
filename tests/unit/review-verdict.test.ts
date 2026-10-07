/**
 * Unit coverage for scripts/review-verdict.mjs, the deterministic /code-review verdict.
 *
 * The old rule lived in prose ("Needs revision" whenever anything was skipped) and the same
 * state got different labels across passes. The fixtures below are shaped like real reports
 * from that period, named by their review session prefix, and pin the new contract:
 *
 * 1. The verdict depends on statuses and checks only, never on how many items there are: one
 *    decision (741), three formerly skipped Lows (742), eight resolved items (746) and twelve
 *    (752) are all Ready, and flipping any single non-quick finding to blocked makes it Blocked.
 * 2. A failed check is Blocked on its own, with a step that names the command to run.
 * 3. A quick fix never changes the verdict, even when it could not be applied.
 * 4. Validation refuses `skipped`, a refuted or blocked finding with no reason, a blocked finding
 *    with no step, a decision with no alternative, and follow-ups with no filed task.
 * 5. The closing block's first line is exactly `Verdict: Ready` or `Verdict: Blocked`, a Blocked
 *    verdict lists one numbered step per blocker, no `Next:` line follows, and the default output
 *    ends with the block.
 * 6. Ledger lines are keyed by file, symbol and mechanism and carry no line number.
 * 7. The Summary counts leave quick findings out of the status counts, count re-raises, list
 *    severities in critical, high, medium, low order, and name each check's value.
 * 8. Every validation branch refuses its malformed input with one exact problem string, and a
 *    quick finding may not carry a decision.
 * 9. A multi-line location, step or decision collapses to one line, so each closing block line
 *    starts with `Verdict:` or `<digits>.` and a Decisions made entry is one line.
 * 10. The command line exits 2 with a usage line for a wrong argument count and with
 *     `could not read` for text that is not JSON.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  validateFindings,
  computeVerdict,
  renderSummary,
  renderClosingBlock,
  renderLedger,
} from '../../scripts/review-verdict.mjs';

const SCRIPT_PATH = path.resolve(__dirname, '../../scripts/review-verdict.mjs');

interface Finding {
  id: number;
  severity: string;
  category: string;
  location: string;
  file: string;
  symbol?: string;
  mechanism: string;
  status: string;
  reason?: string;
  step?: string;
  decision?: { chosen: string; alternative: string };
  quick?: boolean;
  reRaise?: { of: string; newEvidence: string };
}

interface Report {
  checks: { typecheck: string; hmrVitest: string; scopedTests: string };
  findings: Finding[];
  followUps?: Array<{ title: string; location: string; why: string }>;
  followUpTask?: string;
}

const PASSING_CHECKS = { typecheck: 'pass', hmrVitest: 'pass', scopedTests: 'pass' };

function findingOf(id: number, overrides: Partial<Finding> = {}): Finding {
  return {
    id,
    severity: 'low',
    category: 'Maintainability',
    location: `src/main/example-${id}.ts:${10 + id}`,
    file: `src/main/example-${id}.ts`,
    symbol: `exampleFunction${id}`,
    mechanism: `example mechanism ${id}`,
    status: 'fixed',
    ...overrides,
  };
}

function reportOf(findings: Finding[], overrides: Partial<Report> = {}): Report {
  return { checks: { ...PASSING_CHECKS }, findings, ...overrides };
}

function closingBlockLines(report: Report): string[] {
  return renderClosingBlock(report).split('\n');
}

// Every run gets its own folder, and all of them are removed, so a test that runs the CLI twice
// leaks nothing.
const scratchDirectories: string[] = [];

afterEach(() => {
  for (const scratchDirectory of scratchDirectories.splice(0)) {
    fs.rmSync(scratchDirectory, { recursive: true, force: true });
  }
});

interface ScriptResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Runs the CLI with exactly these arguments and no file of its own. */
function runScriptWithArguments(scriptArguments: string[]): ScriptResult {
  try {
    const stdout = execFileSync('node', [SCRIPT_PATH, ...scriptArguments], { encoding: 'utf8', stdio: 'pipe' });
    return { exitCode: 0, stdout, stderr: '' };
  } catch (error) {
    const execError = error as { status?: number | null; stdout?: string; stderr?: string };
    return { exitCode: execError.status ?? -1, stdout: execError.stdout ?? '', stderr: execError.stderr ?? '' };
  }
}

/** Writes the text verbatim (no JSON.stringify) to a findings file, then runs the CLI on it. */
function runScriptWithRawFile(fileContent: string, extraArguments: string[] = []): ScriptResult {
  const scratchDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-review-verdict-'));
  scratchDirectories.push(scratchDirectory);
  const findingsPath = path.join(scratchDirectory, 'findings.json');
  fs.writeFileSync(findingsPath, fileContent);
  return runScriptWithArguments([findingsPath, ...extraArguments]);
}

function runScript(report: unknown, extraArguments: string[] = []): ScriptResult {
  return runScriptWithRawFile(JSON.stringify(report), extraArguments);
}

describe('review-verdict.mjs: real report shapes', () => {
  it('741 f7c7b381: one Low owner decision, formerly Needs revision, is Ready with the decision listed', () => {
    const findings = [
      findingOf(1, { severity: 'medium', category: 'Correctness' }),
      findingOf(2, {
        decision: { chosen: 'follow the Settings project switcher', alternative: 'keep the board project' },
      }),
      ...Array.from({ length: 7 }, (_, offset) => findingOf(3 + offset)),
    ];
    const report = reportOf(findings);
    expect(validateFindings(report)).toEqual([]);
    expect(computeVerdict(report).verdict).toBe('Ready');
    const summary = renderSummary(report);
    expect(summary).toContain('### Decisions made (1)');
    expect(summary).toContain('chose follow the Settings project switcher. The alternative was keep the board project.');
  });

  it('742 34ff16f6: three formerly skipped Lows, now fixed, plus two refuted, is Ready', () => {
    const findings = [
      ...Array.from({ length: 3 }, (_, offset) => findingOf(1 + offset, { severity: 'medium' })),
      ...Array.from({ length: 5 }, (_, offset) => findingOf(4 + offset)),
      findingOf(9, { status: 'refuted', reason: 'the empty array is the intended vacuous case' }),
      findingOf(10, { status: 'refuted', reason: 'pinned by an existing test' }),
    ];
    expect(computeVerdict(reportOf(findings)).verdict).toBe('Ready');
  });

  it('746 5a3373e9: eight resolved items are Ready, and flipping one to blocked gives Blocked', () => {
    const findings = [
      ...Array.from({ length: 2 }, (_, offset) => findingOf(1 + offset, { severity: 'medium' })),
      ...Array.from({ length: 11 }, (_, offset) => findingOf(3 + offset)),
      findingOf(14, { status: 'refuted', reason: 'outside the diff and already guarded' }),
      findingOf(15, { status: 'refuted', reason: 'no input reaches it' }),
    ];
    expect(computeVerdict(reportOf(findings)).verdict).toBe('Ready');

    const withOneBlocked = findings.map((finding) =>
      finding.id === 7
        ? { ...finding, status: 'blocked', reason: 'needs a live CLI capture', step: 'capture a real reply from the CLI into tests/fixtures' }
        : finding,
    );
    const blockedVerdict = computeVerdict(reportOf(withOneBlocked));
    expect(blockedVerdict.verdict).toBe('Blocked');
    expect(blockedVerdict.blockers).toEqual([
      { location: 'src/main/example-7.ts:17', step: 'capture a real reply from the CLI into tests/fixtures' },
    ]);
  });

  it('752 21dc42d9: twelve formerly skipped items resolved are Ready, the same label as one', () => {
    const findings = [
      ...Array.from({ length: 2 }, (_, offset) => findingOf(1 + offset, { severity: 'medium' })),
      ...Array.from({ length: 18 }, (_, offset) => findingOf(3 + offset)),
      ...Array.from({ length: 3 }, (_, offset) => findingOf(21 + offset, { status: 'refuted', reason: 'speculative, no input reaches it' })),
    ];
    expect(computeVerdict(reportOf(findings)).verdict).toBe('Ready');
  });
});

describe('review-verdict.mjs: verdict rules', () => {
  it('blocks on a failed check alone and names the command to run', () => {
    const report = reportOf([findingOf(1)], { checks: { typecheck: 'fail', hmrVitest: 'pass', scopedTests: 'none' } });
    const { verdict, blockers } = computeVerdict(report);
    expect(verdict).toBe('Blocked');
    expect(blockers).toHaveLength(1);
    expect(blockers[0].location).toBe('Typecheck');
    expect(blockers[0].step).toContain('npm run typecheck');
  });

  it('lists every blocked finding and failed check, findings first', () => {
    const report = reportOf(
      [findingOf(1, { status: 'blocked', reason: 'needs a person', step: 'log in to the vendor CLI and capture a reply' })],
      { checks: { typecheck: 'pass', hmrVitest: 'fail', scopedTests: 'fail' } },
    );
    const lines = closingBlockLines(report);
    expect(lines[0]).toBe('Verdict: Blocked');
    expect(lines[1]).toBe('1. src/main/example-1.ts:11: log in to the vendor CLI and capture a reply');
    expect(lines[2]).toMatch(/^2\. HMR vitest: /);
    expect(lines[3]).toMatch(/^3\. Scoped runs of added tests: /);
    expect(lines).toHaveLength(4);
  });

  it('never lets a quick fix change the verdict, even one that could not be applied', () => {
    const report = reportOf([findingOf(1), findingOf(2, { quick: true, status: 'blocked', reason: 'reverted after a type error' })]);
    expect(validateFindings(report)).toEqual([]);
    expect(computeVerdict(report).verdict).toBe('Ready');
    expect(renderSummary(report)).toContain('- Quick fixes: 1');
  });

  it('renders follow-ups and never blocks on them', () => {
    const report = reportOf([findingOf(1)], {
      followUps: [{ title: 'Split the reap scheduler', location: 'src/main/pty/reap.ts', why: 'needs its own design' }],
      followUpTask: 'task 812',
    });
    expect(validateFindings(report)).toEqual([]);
    expect(computeVerdict(report).verdict).toBe('Ready');
    expect(renderSummary(report)).toContain('- Follow-up task: task 812 (1 item)');
  });

  it('is Ready with no findings at all', () => {
    const report = reportOf([], { checks: { typecheck: 'pass', hmrVitest: 'pass', scopedTests: 'none' } });
    expect(validateFindings(report)).toEqual([]);
    expect(closingBlockLines(report)).toEqual(['Verdict: Ready']);
  });

  it('ends the default output with the verdict line', () => {
    const report = reportOf([findingOf(1)]);
    const summaryLines = renderSummary(report).split('\n');
    expect(summaryLines.slice(-2)).toEqual(['', 'Verdict: Ready']);
  });
});

describe('review-verdict.mjs: validation', () => {
  it('refuses the retired skipped status by name', () => {
    const problems = validateFindings(reportOf([findingOf(1, { status: 'skipped' })]));
    expect(problems).toEqual(['findings[0].status must be one of fixed, refuted, blocked (got "skipped")']);
  });

  it('requires a reason for refuted and blocked findings, and a step for a blocked one', () => {
    const problems = validateFindings(
      reportOf([findingOf(1, { status: 'refuted' }), findingOf(2, { status: 'blocked' })]),
    );
    expect(problems).toContain('findings[0].reason is required for a refuted finding');
    expect(problems).toContain('findings[1].reason is required for a blocked finding');
    expect(problems.some((problem) => problem.startsWith('findings[1].step is required'))).toBe(true);
  });

  it('requires both sides of a decision, and only on a fixed finding', () => {
    const problems = validateFindings(
      reportOf([
        findingOf(1, { decision: { chosen: 'option A', alternative: '' } }),
        findingOf(2, { status: 'refuted', reason: 'not real', decision: { chosen: 'A', alternative: 'B' } }),
      ]),
    );
    expect(problems).toContain('findings[0].decision needs both chosen and alternative');
    expect(problems).toContain('findings[1].decision is only valid on a fixed finding');
  });

  it('requires the filed task when there are follow-ups', () => {
    const problems = validateFindings(
      reportOf([], { followUps: [{ title: 'Split it', location: 'src/a.ts', why: 'own design' }] }),
    );
    expect(problems).toEqual([
      'followUpTask is required with followUps: file the one grouped follow-up task first, then record its board id',
    ]);
  });

  it('requires every check and only its allowed values', () => {
    const problems = validateFindings({ checks: { typecheck: 'none', hmrVitest: 'pass' }, findings: [] });
    expect(problems).toContain('checks.typecheck must be one of pass, fail');
    expect(problems).toContain('checks.scopedTests must be one of pass, fail, none');
  });

  it('requires a re-raise to name the ledger line and the new evidence', () => {
    const problems = validateFindings(reportOf([findingOf(1, { reRaise: { of: 'Refuted: src/a.ts f: m - r', newEvidence: '' } })]));
    expect(problems).toEqual(['findings[0].reRaise needs both of and newEvidence']);
  });
});

describe('review-verdict.mjs: validation of a quick finding', () => {
  it('refuses a decision on a quick finding because a choice between valid answers is not mechanical', () => {
    const problems = validateFindings(
      reportOf([findingOf(1, { quick: true, status: 'fixed', decision: { chosen: 'option A', alternative: 'option B' } })]),
    );
    expect(problems).toEqual([
      'findings[0].decision is not valid on a quick finding: a choice between valid answers is not mechanical',
    ]);
  });

  it('still accepts a quick fixed finding that carries no decision', () => {
    expect(validateFindings(reportOf([findingOf(1, { quick: true, status: 'fixed' })]))).toEqual([]);
  });
});

interface ValidationCase {
  name: string;
  report: unknown;
  expectedProblem: string;
}

function reportWithRawFinding(finding: unknown): unknown {
  return { checks: { ...PASSING_CHECKS }, findings: [finding] };
}

const CHECKS_PROBLEM = 'checks must be an object with typecheck, hmrVitest and scopedTests';
const FINDINGS_PROBLEM = 'findings must be an array (empty when nothing was raised)';
const SEVERITY_PROBLEM = 'findings[0].severity must be one of critical, high, medium, low';
const VALID_FOLLOW_UP = { title: 'Split it', location: 'src/a.ts', why: 'own design' };

function reportWithRawFollowUp(followUp: unknown): unknown {
  return { checks: { ...PASSING_CHECKS }, findings: [], followUps: [followUp], followUpTask: 'task 812' };
}

const VALIDATION_CASES: ValidationCase[] = [
  { name: 'a null report', report: null, expectedProblem: 'the findings file must hold a JSON object' },
  { name: 'an array report', report: [], expectedProblem: 'the findings file must hold a JSON object' },
  { name: 'a string report', report: 'findings', expectedProblem: 'the findings file must hold a JSON object' },
  { name: 'missing checks', report: { findings: [] }, expectedProblem: CHECKS_PROBLEM },
  { name: 'null checks', report: { checks: null, findings: [] }, expectedProblem: CHECKS_PROBLEM },
  { name: 'array checks', report: { checks: [], findings: [] }, expectedProblem: CHECKS_PROBLEM },
  { name: 'string checks', report: { checks: 'pass', findings: [] }, expectedProblem: CHECKS_PROBLEM },
  { name: 'missing findings', report: { checks: { ...PASSING_CHECKS } }, expectedProblem: FINDINGS_PROBLEM },
  { name: 'findings that is an object', report: { checks: { ...PASSING_CHECKS }, findings: {} }, expectedProblem: FINDINGS_PROBLEM },
  { name: 'a null finding', report: reportWithRawFinding(null), expectedProblem: 'findings[0] must be an object' },
  { name: 'a string finding', report: reportWithRawFinding('finding'), expectedProblem: 'findings[0] must be an object' },
  { name: 'a finding with no id', report: reportWithRawFinding({ ...findingOf(1), id: undefined }), expectedProblem: 'findings[0].id is required' },
  { name: 'an unknown severity', report: reportWithRawFinding({ ...findingOf(1), severity: 'urgent' }), expectedProblem: SEVERITY_PROBLEM },
  { name: 'a missing severity', report: reportWithRawFinding({ ...findingOf(1), severity: undefined }), expectedProblem: SEVERITY_PROBLEM },
  { name: 'an empty category', report: reportWithRawFinding({ ...findingOf(1), category: '' }), expectedProblem: 'findings[0].category is required' },
  { name: 'an empty location', report: reportWithRawFinding({ ...findingOf(1), location: '' }), expectedProblem: 'findings[0].location is required' },
  { name: 'an empty file', report: reportWithRawFinding({ ...findingOf(1), file: '' }), expectedProblem: 'findings[0].file is required' },
  { name: 'an empty mechanism', report: reportWithRawFinding({ ...findingOf(1), mechanism: '' }), expectedProblem: 'findings[0].mechanism is required' },
  { name: 'a whitespace-only mechanism', report: reportWithRawFinding({ ...findingOf(1), mechanism: '   ' }), expectedProblem: 'findings[0].mechanism is required' },
  {
    name: 'followUps that is a string',
    report: { checks: { ...PASSING_CHECKS }, findings: [], followUps: 'later' },
    expectedProblem: 'followUps must be an array when present',
  },
  {
    name: 'a follow-up with no title',
    report: reportWithRawFollowUp({ location: VALID_FOLLOW_UP.location, why: VALID_FOLLOW_UP.why }),
    expectedProblem: 'followUps[0].title is required',
  },
  {
    name: 'a follow-up with no location',
    report: reportWithRawFollowUp({ title: VALID_FOLLOW_UP.title, why: VALID_FOLLOW_UP.why }),
    expectedProblem: 'followUps[0].location is required',
  },
  {
    name: 'a follow-up with no why',
    report: reportWithRawFollowUp({ title: VALID_FOLLOW_UP.title, location: VALID_FOLLOW_UP.location }),
    expectedProblem: 'followUps[0].why is required',
  },
];

describe('review-verdict.mjs: validation of malformed input', () => {
  it.each(VALIDATION_CASES)('refuses $name with exactly one problem', ({ report, expectedProblem }) => {
    expect(validateFindings(report)).toEqual([expectedProblem]);
  });

  it('accepts the control report the table rows are mutated from', () => {
    expect(validateFindings(reportWithRawFinding(findingOf(1)))).toEqual([]);
    expect(validateFindings(reportWithRawFollowUp(VALID_FOLLOW_UP))).toEqual([]);
  });

  it('accepts a severity in any letter case, the way the Summary counts it', () => {
    expect(validateFindings(reportWithRawFinding({ ...findingOf(1), severity: 'HIGH' }))).toEqual([]);
  });

  it('names title, location and why for a follow-up that is not an object', () => {
    expect(validateFindings(reportWithRawFollowUp(null))).toEqual([
      'followUps[0].title is required',
      'followUps[0].location is required',
      'followUps[0].why is required',
    ]);
  });
});

describe('review-verdict.mjs: summary counts', () => {
  it('leaves a quick blocked finding out of the status counts but lists it under Quick fixes', () => {
    const report = reportOf([findingOf(1), findingOf(2, { quick: true, status: 'blocked', reason: 'reverted after a type error' })]);
    expect(validateFindings(report)).toEqual([]);
    const summaryLines = renderSummary(report).split('\n');
    expect(summaryLines).toContain('- Fixed: 1 (0 by decision). Refuted: 0. Blocked: 0.');
    expect(summaryLines).toContain('- Quick fixes: 1');
  });

  it('leaves quick fixed and quick refuted findings out of the status counts too', () => {
    const report = reportOf([
      findingOf(1),
      findingOf(2, { quick: true, status: 'fixed' }),
      findingOf(3, { quick: true, status: 'refuted', reason: 'not reachable' }),
      findingOf(4, { status: 'refuted', reason: 'pinned by a test' }),
    ]);
    expect(validateFindings(report)).toEqual([]);
    const summaryLines = renderSummary(report).split('\n');
    expect(summaryLines).toContain('- Fixed: 1 (0 by decision). Refuted: 1. Blocked: 0.');
    expect(summaryLines).toContain('- Quick fixes: 2');
  });

  it('counts a finding that carries reRaise under Re-raised with new evidence', () => {
    const reRaised = findingOf(2, {
      reRaise: {
        of: 'Refuted: src/main/example-2.ts exampleFunction2: example mechanism 2 - not reachable',
        newEvidence: 'a captured CLI reply reaches the branch',
      },
    });
    const report = reportOf([findingOf(1), reRaised]);
    expect(validateFindings(report)).toEqual([]);
    expect(renderSummary(report).split('\n')).toContain('- Re-raised with new evidence: 1');
    expect(renderSummary(reportOf([findingOf(1)])).split('\n')).toContain('- Re-raised with new evidence: 0');
  });

  it('lists severity counts in critical, high, medium, low order, whatever the letter case', () => {
    const severities = ['low', 'medium', 'High', 'low', 'critical', 'medium', 'low', 'high', 'medium', 'low'];
    const report = reportOf(severities.map((severity, severityIndex) => findingOf(severityIndex + 1, { severity })));
    expect(validateFindings(report)).toEqual([]);
    expect(renderSummary(report).split('\n')).toContain('- Findings: 1 critical, 2 high, 3 medium, 4 low');
  });

  it('names each check by its lowercased label and its own value', () => {
    const report = reportOf([], { checks: { typecheck: 'fail', hmrVitest: 'pass', scopedTests: 'none' } });
    expect(validateFindings(report)).toEqual([]);
    expect(renderSummary(report).split('\n')).toContain(
      '- Checks: typecheck fail, hmr vitest pass, scoped runs of added tests none',
    );
  });

  it('renders the follow-up item count, plural for two and absent for none', () => {
    const twoFollowUps = reportOf([findingOf(1)], {
      followUps: [VALID_FOLLOW_UP, { title: 'Rename the helper', location: 'src/b.ts', why: 'touches every caller' }],
      followUpTask: 'task 812',
    });
    expect(validateFindings(twoFollowUps)).toEqual([]);
    expect(renderSummary(twoFollowUps).split('\n')).toContain('- Follow-up task: task 812 (2 items)');
    expect(renderSummary(reportOf([findingOf(1)])).split('\n')).toContain('- Follow-up task: none');
  });
});

describe('review-verdict.mjs: one-line collapsing', () => {
  it('keeps every closing block item on one line when location and step span lines', () => {
    const report = reportOf([
      findingOf(1, {
        status: 'blocked',
        reason: 'needs a person',
        location: 'src/main/first.ts:10\n   (inside   the\nreap loop)',
        step: 'capture a reply\n\n   from the CLI,\r\nthen   rerun',
      }),
      findingOf(2, {
        status: 'blocked',
        reason: 'needs a person',
        location: 'src/main/second.ts:20',
        step: 'rebuild\nthe   fixture',
      }),
    ]);
    expect(validateFindings(report)).toEqual([]);
    const expectedLines = [
      'Verdict: Blocked',
      '1. src/main/first.ts:10 (inside the reap loop): capture a reply from the CLI, then rerun',
      '2. src/main/second.ts:20: rebuild the fixture',
    ];
    const closingLines = closingBlockLines(report);
    expect(closingLines).toEqual(expectedLines);
    for (const line of closingLines) expect(line).toMatch(/^(Verdict:|\d+\.)/);
    expect(renderSummary(report).split('\n').slice(-expectedLines.length)).toEqual(expectedLines);
  });

  it('renders a decision with multi-line fields as one Decisions made entry', () => {
    const report = reportOf([
      findingOf(1, {
        location: 'src/main/a.ts:5\n  and src/main/b.ts:9',
        decision: { chosen: 'keep the\n   old   copy', alternative: 'use\nthe new\n\n copy' },
      }),
    ]);
    expect(validateFindings(report)).toEqual([]);
    const summaryLines = renderSummary(report).split('\n');
    const headingIndex = summaryLines.indexOf('### Decisions made (1)');
    expect(headingIndex).toBeGreaterThan(-1);
    expect(summaryLines.slice(headingIndex)).toEqual([
      '### Decisions made (1)',
      '',
      '1. src/main/a.ts:5 and src/main/b.ts:9: chose keep the old copy. The alternative was use the new copy.',
      '',
      'Verdict: Ready',
    ]);
  });
});

describe('review-verdict.mjs: ledger', () => {
  it('keys refuted items and decisions by file, symbol and mechanism, with no line number', () => {
    const report = reportOf([
      findingOf(1, { status: 'refuted', reason: 'vacuous truth is intended,\npinned by a test' }),
      findingOf(2, { decision: { chosen: 'keep the copy verb "Build"', alternative: 'use "Index"' } }),
      findingOf(3, { symbol: undefined, status: 'refuted', reason: 'docs only' }),
      findingOf(4),
    ]);
    expect(renderLedger(report).split('\n')).toEqual([
      'Refuted: src/main/example-1.ts exampleFunction1: example mechanism 1 - vacuous truth is intended, pinned by a test',
      'Refuted: src/main/example-3.ts: example mechanism 3 - docs only',
      'Decisions: src/main/example-2.ts exampleFunction2: example mechanism 2 - chose keep the copy verb "Build" over use "Index"',
    ]);
    expect(renderLedger(report)).not.toMatch(/\.ts:\d/);
  });
});

describe('review-verdict.mjs: command line', () => {
  it('prints the summary and closing block and exits 0 for both verdicts', () => {
    const blocked = runScript(
      reportOf([findingOf(1, { status: 'blocked', reason: 'needs a person', step: 'run the packaged build on macOS' })]),
    );
    expect(blocked.exitCode).toBe(0);
    const outputLines = blocked.stdout.trimEnd().split('\n');
    expect(outputLines).toContain('Verdict: Blocked');
    expect(outputLines[outputLines.length - 1]).toBe('1. src/main/example-1.ts:11: run the packaged build on macOS');
  });

  it('ends the default output of a Ready report with the verdict line and exits 0', () => {
    const result = runScript(reportOf([findingOf(1)]));
    expect(result.exitCode).toBe(0);
    const outputLines = result.stdout.trimEnd().split('\n');
    expect(outputLines[outputLines.length - 1]).toBe('Verdict: Ready');
    expect(result.stdout).not.toContain('Next:');
  });

  it('exits 2 with a usage line when no findings file is given', () => {
    const result = runScriptWithArguments([]);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('usage:');
  });

  it('exits 2 with a usage line when only the --ledger flag is given', () => {
    const result = runScriptWithArguments(['--ledger']);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('usage:');
  });

  it('exits 2 with a usage line for two findings files even when the first is valid', () => {
    const result = runScript(reportOf([findingOf(1)]), ['second-findings.json']);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('usage:');
  });

  it('exits 2 and says it could not read a findings file that is not JSON', () => {
    const result = runScriptWithRawFile('{not json');
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('could not read');
  });

  it('prints only the ledger with --ledger', () => {
    const result = runScript(reportOf([findingOf(1, { status: 'refuted', reason: 'not reachable' })]), ['--ledger']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('Refuted: src/main/example-1.ts exampleFunction1: example mechanism 1 - not reachable');
  });

  it('exits 2 and lists every problem for an invalid file', () => {
    const result = runScript({ checks: PASSING_CHECKS, findings: [findingOf(1, { status: 'skipped' })] });
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('invalid findings file (1 problem):');
    expect(result.stderr).toContain('(got "skipped")');
  });
});
