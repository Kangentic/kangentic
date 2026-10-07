/**
 * Pins the E4 verdict replay in scripts/review-eval/run-verdict-replay.mjs:
 *
 * 1. reportForPass turns each historical item into the finding the real verdict function accepts:
 *    every `mappedTo` value lands in the right status, an unrecognized severity reads as low, and
 *    the macOS reroute fires on mac, macOS and darwin but not on a word that merely starts with
 *    "mac".
 * 2. replay counts the bounces a pass avoided, which passes stay blocked, the old-Clean passes that
 *    would now block, and the same counts per level, over a small inline corpus.
 * 3. replay over the committed verdict-replay.json returns the exact numbers
 *    docs/code-review-fanout-audit.md section 15.2 cites, so that claim stays reproducible.
 *
 * Never import scripts/review-eval/prepare.mjs from a test: its top-level code runs git and exits.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { replay, reportForPass } from '../../scripts/review-eval/run-verdict-replay.mjs';

interface ReplayItem {
  ref?: string;
  severity?: string;
  skipReason?: string;
  mappedTo: string;
  why?: string;
}

interface ReplayPass {
  task: string;
  pass?: number;
  session?: string;
  level: 'item' | 'verdict-line';
  oldVerdict: string;
  checkFailed?: boolean;
  items: ReplayItem[];
}

interface ReplayFinding {
  id: number;
  severity: string;
  status: string;
  reason?: string;
  step?: string;
  decision?: { chosen: string; alternative: string };
}

interface ReplayReport {
  checks: { typecheck: string; hmrVitest: string; scopedTests: string };
  findings: ReplayFinding[];
  followUps: Array<{ title: string; location: string; why: string }>;
  followUpTask?: string;
}

function singleItemPass(item: ReplayItem): ReplayPass {
  return { task: 'T0', pass: 1, level: 'item', oldVerdict: 'Needs revision', items: [item] };
}

describe('reportForPass', () => {
  it('maps every mappedTo value to its finding status or a follow-up', () => {
    const pass: ReplayPass = {
      task: 'T1',
      pass: 1,
      level: 'item',
      oldVerdict: 'Needs revision',
      items: [
        { ref: 'finding 1', severity: 'High', skipReason: 'fixed in place', mappedTo: 'fixed' },
        { ref: 'finding 2', severity: 'Low', skipReason: 'not a defect', mappedTo: 'refuted', why: 'the caller already guards it' },
        { ref: 'finding 3', severity: 'Medium', skipReason: 'needs a person to run it', mappedTo: 'blocked', why: 'run it on the shared runner' },
        { ref: 'finding 4', severity: 'Medium', skipReason: 'two valid designs', mappedTo: 'decision', why: 'decision: pick one' },
        { ref: 'finding 5', severity: 'Low', skipReason: 'out of scope for this change', mappedTo: 'followUp' },
      ],
    };

    const report: ReplayReport = reportForPass(pass);

    expect(report.findings.map((finding) => [finding.id, finding.status])).toEqual([
      [1, 'fixed'],
      [2, 'refuted'],
      [3, 'blocked'],
      [4, 'fixed'],
    ]);
    expect(report.findings[1].reason).toBe('the caller already guards it');
    expect(report.findings[2].reason).toBe('needs a person to run it');
    expect(report.findings[2].step).toBe('run it on the shared runner');
    expect(report.findings[3].decision).toEqual({ chosen: 'the recommended option', alternative: 'the other option' });
    expect(report.findings[0].decision).toBeUndefined();
    expect(report.followUps).toEqual([
      { title: 'finding 5', location: 'finding 5', why: 'out of scope for this change' },
    ]);
    expect(report.followUpTask).toBe('replay');
  });

  it('records no followUpTask when a pass raised no follow-up', () => {
    const report: ReplayReport = reportForPass(singleItemPass({ ref: 'finding 1', severity: 'Low', skipReason: 'done', mappedTo: 'fixed' }));

    expect(report.followUps).toEqual([]);
    expect('followUpTask' in report).toBe(false);
  });

  it.each([
    ['Medium', 'medium'],
    ['High', 'high'],
    ['CRITICAL', 'critical'],
    ['Low, coverage', 'low'],
    // These two have no severity word, so only the fallback can produce 'low' (a string with "low"
    // inside it would pass through the includes() match and never reach the fallback).
    ['n/a', 'low'],
    ['', 'low'],
  ])('reads historical severity %j as %s', (rawSeverity, expectedSeverity) => {
    const report: ReplayReport = reportForPass(singleItemPass({ ref: 'finding 1', severity: rawSeverity, skipReason: 'done', mappedTo: 'fixed' }));

    expect(report.findings[0].severity).toBe(expectedSeverity);
  });

  it('reads a missing severity as low', () => {
    const report: ReplayReport = reportForPass(singleItemPass({ ref: 'finding 1', skipReason: 'done', mappedTo: 'fixed' }));

    expect(report.findings[0].severity).toBe('low');
  });

  it.each([
    'needs a Mac to reproduce',
    'macOS only keychain behavior',
    'darwin specific path',
  ])('reroutes a blocked item that names macOS only when macosRunnable is set: %s', (skipReason) => {
    const pass = singleItemPass({ ref: 'finding 1', severity: 'Low', skipReason, mappedTo: 'blocked', why: 'needs a Mac' });

    const byDefault: ReplayReport = reportForPass(pass);
    const withMacosRunnable: ReplayReport = reportForPass(pass, { macosRunnable: true });

    expect(byDefault.findings[0].status).toBe('blocked');
    expect(withMacosRunnable.findings[0].status).toBe('fixed');
  });

  it.each([
    'a macro expands before the check',
    'needs a machine with a GPU',
  ])('keeps a blocked item that only resembles macOS blocked under macosRunnable: %s', (skipReason) => {
    const pass = singleItemPass({ ref: 'finding 1', severity: 'Low', skipReason, mappedTo: 'blocked', why: 'needs a person' });

    const report: ReplayReport = reportForPass(pass, { macosRunnable: true });

    expect(report.findings[0].status).toBe('blocked');
  });

  it('never reroutes a refuted item that names macOS', () => {
    const pass = singleItemPass({ ref: 'finding 1', severity: 'Low', skipReason: 'macOS already handled', mappedTo: 'refuted', why: 'covered' });

    const report: ReplayReport = reportForPass(pass, { macosRunnable: true });

    expect(report.findings[0].status).toBe('refuted');
  });

  it('records a failed check on the typecheck slot', () => {
    const failing: ReplayReport = reportForPass({ ...singleItemPass({ ref: 'finding 1', skipReason: 'done', mappedTo: 'fixed' }), checkFailed: true });
    const passing: ReplayReport = reportForPass(singleItemPass({ ref: 'finding 1', skipReason: 'done', mappedTo: 'fixed' }));

    expect(failing.checks.typecheck).toBe('fail');
    expect(passing.checks.typecheck).toBe('pass');
  });
});

describe('replay over an inline corpus', () => {
  const passes: ReplayPass[] = [
    // Needs revision then, Ready now: fixed, refuted, decision and follow-up items never block.
    {
      task: 'T1',
      pass: 1,
      level: 'item',
      oldVerdict: 'Needs revision',
      items: [
        { ref: 'finding 1', severity: 'High', skipReason: 'fixed in place', mappedTo: 'fixed' },
        { ref: 'finding 2', severity: 'n/a', skipReason: 'not a defect', mappedTo: 'refuted', why: 'the caller already guards it' },
        { ref: 'finding 3', severity: 'Medium', skipReason: 'two valid designs', mappedTo: 'decision', why: 'decision: pick one' },
        { ref: 'finding 4', severity: 'Low, coverage', skipReason: 'out of scope for this change', mappedTo: 'followUp' },
      ],
    },
    // Needs revision then, still Blocked now: a blocked item that does not name macOS.
    {
      task: 'T2',
      pass: 1,
      level: 'item',
      oldVerdict: 'Needs revision',
      items: [{ ref: 'finding 1', severity: 'High', skipReason: 'needs the shared runner', mappedTo: 'blocked', why: 'run it on the runner' }],
    },
    // Blocked only because it needs a Mac: Blocked by default, Ready when macOS counts as runnable.
    {
      task: 'T3',
      pass: 2,
      level: 'verdict-line',
      oldVerdict: 'Needs revision',
      items: [{ ref: 'finding 1', severity: 'Medium', skipReason: 'Needs a macOS machine to reproduce', mappedTo: 'blocked', why: 'run it on a Mac' }],
    },
    // No pass number: the label falls back to the session id.
    {
      task: 'T4',
      session: 'session-four',
      level: 'verdict-line',
      oldVerdict: 'Needs revision',
      items: [{ ref: 'finding 1', severity: 'Low', skipReason: 'needs a person', mappedTo: 'blocked', why: 'a person must decide' }],
    },
    // Clean then, Blocked now: counted in oldCleanNowBlocked, never in the Needs revision totals.
    {
      task: 'T5',
      pass: 1,
      level: 'verdict-line',
      oldVerdict: 'Clean',
      items: [{ ref: 'finding 1', severity: 'Low', skipReason: 'needs a person', mappedTo: 'blocked', why: 'a person must decide' }],
    },
    // Clean then, Ready now.
    {
      task: 'T6',
      pass: 1,
      level: 'item',
      oldVerdict: 'Clean',
      items: [{ ref: 'finding 1', severity: 'Low', skipReason: 'fixed in place', mappedTo: 'fixed' }],
    },
  ];

  it('counts bounces avoided, the passes still blocked, old-Clean blocks and each level', () => {
    expect(replay(passes)).toEqual({
      passes: 6,
      oldNeedsRevision: 4,
      bouncesAvoided: 1,
      stillBlocked: ['task T2 1', 'task T3 2', 'task T4 session-four'],
      oldCleanNowBlocked: 1,
      byLevel: [
        { level: 'item', oldNeedsRevision: 2, bouncesAvoided: 1 },
        { level: 'verdict-line', oldNeedsRevision: 2, bouncesAvoided: 0 },
      ],
    });
  });

  it('moves the macOS-only skip from still blocked to avoided with macosRunnable', () => {
    expect(replay(passes, { macosRunnable: true })).toEqual({
      passes: 6,
      oldNeedsRevision: 4,
      bouncesAvoided: 2,
      stillBlocked: ['task T2 1', 'task T4 session-four'],
      oldCleanNowBlocked: 1,
      byLevel: [
        { level: 'item', oldNeedsRevision: 2, bouncesAvoided: 1 },
        { level: 'verdict-line', oldNeedsRevision: 2, bouncesAvoided: 1 },
      ],
    });
  });

  it('counts a pass whose check failed as Blocked even when every item is fixed', () => {
    const failedCheckPass: ReplayPass = {
      task: 'T7',
      pass: 1,
      level: 'item',
      oldVerdict: 'Needs revision',
      checkFailed: true,
      items: [{ ref: 'finding 1', severity: 'Low', skipReason: 'fixed in place', mappedTo: 'fixed' }],
    };

    const result = replay([failedCheckPass]);

    expect(result.bouncesAvoided).toBe(0);
    expect(result.stillBlocked).toEqual(['task T7 1']);
  });

  it('matches the Needs revision wording case-insensitively and ignores any other verdict word', () => {
    const lowerCasePass: ReplayPass = { ...passes[0], task: 'T8', oldVerdict: 'needs revision (3 skipped)' };
    const readyPass: ReplayPass = { ...passes[0], task: 'T9', oldVerdict: 'Ready' };

    const result = replay([lowerCasePass, readyPass]);

    expect(result.oldNeedsRevision).toBe(1);
    expect(result.bouncesAvoided).toBe(1);
  });
});

describe('replay over the committed verdict-replay.json', () => {
  const corpusPath = path.resolve(__dirname, '../../scripts/review-eval/verdict-replay.json');
  const corpus: { passes: ReplayPass[] } = JSON.parse(fs.readFileSync(corpusPath, 'utf8'));

  it('validates every pass and returns the numbers docs section 15.2 cites', () => {
    const result = replay(corpus.passes);

    expect(result.passes).toBe(59);
    expect(result.oldNeedsRevision).toBe(41);
    expect(result.bouncesAvoided).toBe(35);
    expect(result.stillBlocked).toEqual(['task 736 1', 'task 736 4', 'task 736 5', 'task 749 1', 'task 749 2', 'task 758 1']);
    expect(result.oldCleanNowBlocked).toBe(0);
    expect(result.byLevel).toEqual([
      { level: 'item', oldNeedsRevision: 18, bouncesAvoided: 13 },
      { level: 'verdict-line', oldNeedsRevision: 23, bouncesAvoided: 22 },
    ]);
  });

  it('counts the three macOS-only skips as runnable with macosRunnable', () => {
    const result = replay(corpus.passes, { macosRunnable: true });

    expect(result.bouncesAvoided).toBe(38);
    expect(result.stillBlocked).toEqual(['task 749 1', 'task 749 2', 'task 758 1']);
    const levelBounces = result.byLevel.reduce((total: number, level: { bouncesAvoided: number }) => total + level.bouncesAvoided, 0);
    expect(levelBounces).toBe(38);
  });
});
