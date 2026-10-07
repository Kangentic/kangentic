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
 * 5. The closing block's first line is exactly `Verdict: Ready` or `Verdict: Blocked`, its last
 *    line starts with `Next:`, and the default output ends with it.
 * 6. Ledger lines are keyed by file, symbol and mechanism and carry no line number.
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

let scratchDirectory: string | null = null;

afterEach(() => {
  if (scratchDirectory !== null) fs.rmSync(scratchDirectory, { recursive: true, force: true });
  scratchDirectory = null;
});

function runScript(report: unknown, extraArguments: string[] = []): { exitCode: number; stdout: string; stderr: string } {
  scratchDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-review-verdict-'));
  const findingsPath = path.join(scratchDirectory, 'findings.json');
  fs.writeFileSync(findingsPath, JSON.stringify(report));
  try {
    const stdout = execFileSync('node', [SCRIPT_PATH, findingsPath, ...extraArguments], { encoding: 'utf8', stdio: 'pipe' });
    return { exitCode: 0, stdout, stderr: '' };
  } catch (error) {
    const execError = error as { status?: number | null; stdout?: string; stderr?: string };
    return { exitCode: execError.status ?? -1, stdout: execError.stdout ?? '', stderr: execError.stderr ?? '' };
  }
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
    expect(lines[4]).toBe('Next: move the card back to Executing and do the steps above.');
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
    expect(closingBlockLines(report)).toEqual(['Verdict: Ready', 'Next: move the card to Testing.']);
  });

  it('ends the default output with the closing block', () => {
    const report = reportOf([findingOf(1)]);
    const summaryLines = renderSummary(report).split('\n');
    expect(summaryLines.slice(-2)).toEqual(['Verdict: Ready', 'Next: move the card to Testing.']);
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
    expect(outputLines[outputLines.length - 1]).toBe('Next: move the card back to Executing and do the steps above.');
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
