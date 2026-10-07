/**
 * A /code-review pass commits its ledger in the commit body: one `Refuted:` or `Decisions:` line
 * per item, keyed by file, symbol and mechanism, so a later pass can read each item back from a
 * single line (scripts/review-verdict.mjs --ledger). Commitlint reads those `Token: value` lines
 * as footer trailers, and config-conventional caps a footer line at 100 characters, which nearly
 * every real ledger line passes. The husky commit-msg hook then refuses the review commit, and the
 * ledger never reaches the branch.
 *
 * These tests run the repo's real commitlint, with the config in package.json, over messages built
 * from renderLedger's own output:
 *
 * 1. A review commit (subject, wrapped body, ledger, co-author trailer) passes.
 * 2. A ledger-only `chore(review):` commit passes.
 * 3. A broken subject still fails, so a passing run means the lint ran, not that it was skipped.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { renderLedger } from '../../scripts/review-verdict.mjs';

const REPO_ROOT = path.resolve(__dirname, '../..');
const COMMITLINT_CLI = path.join(REPO_ROOT, 'node_modules', '@commitlint', 'cli', 'cli.js');

const scratchDirectories: string[] = [];

afterEach(() => {
  for (const scratchDirectory of scratchDirectories.splice(0)) {
    fs.rmSync(scratchDirectory, { recursive: true, force: true });
  }
});

function lintMessage(message: string): { exitCode: number; output: string } {
  const scratchDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-review-commitlint-'));
  scratchDirectories.push(scratchDirectory);
  const messagePath = path.join(scratchDirectory, 'COMMIT_MSG.tmp');
  fs.writeFileSync(messagePath, message);
  try {
    const output = execFileSync(process.execPath, [COMMITLINT_CLI, '--edit', messagePath], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: 'pipe',
    });
    return { exitCode: 0, output };
  } catch (error) {
    const execError = error as { status?: number | null; stdout?: string; stderr?: string };
    return { exitCode: execError.status ?? -1, output: `${execError.stdout ?? ''}${execError.stderr ?? ''}` };
  }
}

const LEDGER = renderLedger({
  checks: { typecheck: 'pass', hmrVitest: 'pass', scopedTests: 'pass' },
  findings: [
    {
      id: 1,
      severity: 'low',
      category: 'Performance',
      location: 'scripts/build-review-pack.mjs:712',
      file: 'scripts/build-review-pack.mjs',
      symbol: 'shardRanges',
      mechanism: 'greedy packing can leave a small tail shard that pays a full finder floor',
      status: 'refuted',
      reason: 'greedy 1500-line shards are the shape Phase 0 measured, and folding a tail breaks the stated within-budget guarantee',
    },
    {
      id: 2,
      severity: 'low',
      category: 'Correctness',
      location: 'scripts/review-verdict.mjs:123',
      file: 'scripts/review-verdict.mjs',
      symbol: 'validateFindings',
      mechanism: 'quick finding with a decision is counted in Decisions made but left out of the Fixed count',
      status: 'fixed',
      decision: {
        chosen: 'refuse a decision on a quick finding',
        alternative: 'count the by-decision share with the same quick filter as the Fixed count',
      },
    },
  ],
});

describe('review ledger under the commit-msg hook', () => {
  it('renders ledger lines longer than the 100-character footer cap it has to survive', () => {
    const ledgerLines = LEDGER.split('\n');
    expect(ledgerLines).toHaveLength(2);
    for (const ledgerLine of ledgerLines) expect(ledgerLine.length).toBeGreaterThan(100);
  });

  it('accepts a review commit whose body carries the ledger', () => {
    const message = [
      'fix(review): pin the verdict script',
      '',
      '- review-verdict.mjs: refuse a decision on a quick finding.',
      '',
      LEDGER,
      '',
      'Co-Authored-By: Example Author <author@example.com>',
      '',
    ].join('\n');
    const result = lintMessage(message);
    expect(result.output).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('accepts a ledger-only chore(review) commit', () => {
    const result = lintMessage(['chore(review): record refuted findings and decisions', '', LEDGER, ''].join('\n'));
    expect(result.output).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('still refuses a subject that is not conventional, so a pass is a real lint', () => {
    const result = lintMessage(['Record refuted findings', '', LEDGER, ''].join('\n'));
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain('type may not be empty');
  });
});
