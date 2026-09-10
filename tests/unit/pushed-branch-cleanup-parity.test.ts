import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Two invariants about the branch-identity columns on `tasks`, both keyed on
 * the writes that discard a LOCAL checkout.
 *
 * `resolved_base_branch` describes the checkout: the base the worktree was
 * actually cut from. It has to be discarded wherever `branch_name` is, or a
 * task whose worktree and branch were just reclaimed keeps measuring the PR
 * ladder's base-relative guards against a base it no longer sits on.
 *
 * `pushed_branch` describes the WORK, not the checkout: the remote branch the
 * work was pushed to, captured from the agent's own `git push` or by the
 * ladder's remote-tip inference. It is a remote fact that outlives the local
 * directory, and for a task with no worktree it is the ONLY PR anchor the app
 * can record. So the invariant is the opposite one: no cleanup path nulls it.
 * It used to be nulled alongside `branch_name` on the theory that a reset task
 * "no longer has any work"; `pr_number` survives every one of those paths, so
 * the reset never actually forgot the PR, and nulling `pushed_branch` only
 * stranded a task whose PR had not linked yet when the reset ran (resolver
 * down). Those paths capture `head_sha` before discarding the checkout for the
 * same reason. The one legal `pushed_branch: null` is the row insert.
 *
 * Deliberately keyed on `branch_name: null` rather than on the cleanup
 * functions: `deleteTaskWorktree` nulls `worktree_path` on the Done move but
 * PRESERVES `branch_name`, and it must preserve `resolved_base_branch` as
 * well. "Wherever the branch goes" is the correct trigger, not "wherever the
 * worktree goes".
 *
 * This is a static scan rather than a behavioural test because the sites are
 * spread across four modules with different callers, and the invariant is
 * about every write, not any one code path.
 *
 * It keys on the OCCURRENCE of `branch_name: null` and then brace-matches out to
 * the object literal containing it, rather than matching the shape of the call
 * around it. An earlier version matched `update({ ... })` with an inline literal,
 * which silently skipped the equally ordinary
 *
 *   const patch = { id, worktree_path: null, branch_name: null };
 *   tasks.update(patch);
 *
 * and skipped any nested literal too. A skipped site produced no offender AND no
 * drop in the guard-the-guard count, so both tests stayed green while the
 * invariant went unenforced. Anything this scan cannot resolve is now REPORTED
 * rather than passed over, so the failure mode is a loud "tighten the scan"
 * instead of silence.
 */

const REPO_ROOT = path.resolve(__dirname, '../..');
const SCAN_DIR = 'src/main';
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);

/** The write this invariant keys on. */
const CLEARS_BRANCH_NAME = /\bbranch_name\s*:\s*null/g;

/** Columns that must be discarded in the same write that discards `branch_name`. */
const CHECKOUT_IDENTITY_COLUMNS = ['resolved_base_branch'];

/**
 * Files where a `branch_name: null` write is allowed to skip the `head_sha`
 * capture, with the reason. Empty today: all four known cleanup sites capture
 * it via `readWorktreeHead` / `readLocalBranchSha` before discarding the
 * checkout. A future site added here needs a comment explaining why it is
 * exempt (e.g. the branch never had a checkout to read a tip from).
 */
const HEAD_SHA_CAPTURE_ALLOWED_MISSING = new Set<string>([]);

/** The write that must not exist outside the row insert. */
const CLEARS_PUSHED_BRANCH = /\bpushed_branch\s*:\s*null/g;
const PUSHED_BRANCH_NULL_ALLOWED_IN = new Set(['src/main/db/repositories/task-repository.ts']);

function collectSourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(fullPath));
    } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(fullPath);
    }
  }
  return files;
}

/**
 * The object literal enclosing `index`, found by walking braces outward.
 *
 * Independent of how the literal reaches the repository: inline in the call, or
 * assigned to a variable first. Returns null when the braces do not balance out
 * to a literal, which callers must treat as "could not analyze" and report,
 * never as "fine".
 */
function enclosingObjectLiteral(source: string, index: number): string | null {
  let depth = 0;
  let start = -1;
  for (let cursor = index; cursor >= 0; cursor -= 1) {
    const character = source[cursor];
    if (character === '}') {
      depth += 1;
    } else if (character === '{') {
      if (depth === 0) {
        start = cursor;
        break;
      }
      depth -= 1;
    }
  }
  if (start < 0) return null;

  depth = 0;
  for (let cursor = start; cursor < source.length; cursor += 1) {
    const character = source[cursor];
    if (character === '{') {
      depth += 1;
    } else if (character === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, cursor + 1);
    }
  }
  return null;
}

function relativePath(filePath: string): string {
  return path.relative(REPO_ROOT, filePath).replace(/\\/g, '/');
}

/** Every `branch_name: null` write in the scanned tree, with its literal resolved. */
function findBranchClearingWrites(): Array<{ file: string; literal: string | null }> {
  const writes: Array<{ file: string; literal: string | null }> = [];
  for (const filePath of collectSourceFiles(path.join(REPO_ROOT, SCAN_DIR))) {
    const source = fs.readFileSync(filePath, 'utf8');
    for (const match of source.matchAll(CLEARS_BRANCH_NAME)) {
      writes.push({
        file: relativePath(filePath),
        literal: enclosingObjectLiteral(source, match.index),
      });
    }
  }
  return writes;
}

/** Every file in the scanned tree that writes `pushed_branch: null`. */
function findPushedBranchClearingFiles(): string[] {
  const files: string[] = [];
  for (const filePath of collectSourceFiles(path.join(REPO_ROOT, SCAN_DIR))) {
    const source = fs.readFileSync(filePath, 'utf8');
    if (CLEARS_PUSHED_BRANCH.test(source)) files.push(relativePath(filePath));
    CLEARS_PUSHED_BRANCH.lastIndex = 0;
  }
  return files;
}

describe('checkout-identity columns are cleared wherever branch_name is cleared', () => {
  it.each(CHECKOUT_IDENTITY_COLUMNS)('every task update that nulls branch_name also nulls %s', (column) => {
    const offenders: string[] = [];

    for (const { file, literal } of findBranchClearingWrites()) {
      if (literal == null) {
        offenders.push(`${file}: could not resolve the object literal around a \`branch_name: null\``);
        continue;
      }
      if (new RegExp(`\\b${column}\\s*:\\s*null`).test(literal)) continue;
      offenders.push(`${file}: ${literal.replace(/\s+/g, ' ')}`);
    }

    expect(
      offenders,
      `These task updates discard the local branch but keep ${column}, which leaves the PR ladder `
      + `measuring against a base the task no longer sits on. Add \`${column}: null\` to each:\n`
      + offenders.join('\n'),
    ).toEqual([]);
  });

  it('finds the known cleanup sites, so the scan cannot silently match nothing', () => {
    // Guards the guard. The scan is only as good as its trigger, so a refactor
    // that renamed the column or moved every site behind a helper would
    // otherwise leave the test above passing over zero writes. Four sites:
    // task-cleanup (the To Do reset and delete), transition-engine (the
    // cleanup_worktree action), resource-cleanup (the Backlog sweep), and the
    // shared missing-worktree demotion the two startup passes call.
    expect(findBranchClearingWrites()).toHaveLength(4);
  });
});

/**
 * The `head_sha` capture-and-spread shape: every cleanup site that discards
 * the local branch first reads the tip commit (via `readWorktreeHead` when a
 * worktree checkout is still readable, or `readLocalBranchSha` when only the
 * ref survives) and folds it into the SAME update that nulls `branch_name`,
 * via `...(capturedSha ? { head_sha: capturedSha } : {})`. Without it, a
 * cleanup path silently loses the one anchor that survives the checkout: a
 * task whose PR never linked before the resolver went down (or was never
 * checked) can then never link it again, because the commit that would have
 * proven the work is gone with the branch name.
 *
 * Same scanning approach as the `resolved_base_branch` guard above, reusing
 * `findBranchClearingWrites()`: brace-match out to the enclosing object
 * literal and check what it contains, rather than matching the call's shape.
 * A literal that cannot be resolved is reported as an offender (never passed
 * over silently), matching this file's existing "unresolvable is a failure,
 * not a pass" policy.
 */
describe('a captured head_sha rides along wherever branch_name is cleared', () => {
  it('every task update that nulls branch_name also carries a head_sha capture (or is on the named allowlist)', () => {
    const offenders: string[] = [];

    for (const { file, literal } of findBranchClearingWrites()) {
      if (HEAD_SHA_CAPTURE_ALLOWED_MISSING.has(file)) continue;
      if (literal == null) {
        offenders.push(`${file}: could not resolve the object literal around a \`branch_name: null\``);
        continue;
      }
      if (/\bhead_sha\s*:/.test(literal)) continue;
      offenders.push(`${file}: ${literal.replace(/\s+/g, ' ')}`);
    }

    expect(
      offenders,
      'These task updates discard the local branch but write no head_sha, which loses the one PR '
      + 'anchor that survives the checkout for a task whose PR never linked. Capture the tip via '
      + 'readWorktreeHead/readLocalBranchSha before the update and fold it in with '
      + '`...(capturedSha ? { head_sha: capturedSha } : {})`, or add the file to '
      + 'HEAD_SHA_CAPTURE_ALLOWED_MISSING with a comment explaining why:\n'
      + offenders.join('\n'),
    ).toEqual([]);
  });

  it('finds the known cleanup sites, so the scan cannot silently match nothing', () => {
    // Same guard-the-guard as the resolved_base_branch check above: the four
    // known sites, none of them allowlisted.
    expect(findBranchClearingWrites()).toHaveLength(4);
    expect(HEAD_SHA_CAPTURE_ALLOWED_MISSING.size).toBe(0);
  });
});

describe('pushed_branch is never discarded by a cleanup path', () => {
  it('only the row insert writes pushed_branch: null', () => {
    const offenders = findPushedBranchClearingFiles().filter((file) => !PUSHED_BRANCH_NULL_ALLOWED_IN.has(file));

    expect(
      offenders,
      'These files null pushed_branch. It is a remote fact and a PR anchor that outlives the local '
      + 'checkout (for a task with no worktree, the only one), so a cleanup path must keep it and only '
      + 'a newer observation may overwrite it:\n' + offenders.join('\n'),
    ).toEqual([]);
  });

  it('finds the row insert, so the scan cannot silently match nothing', () => {
    expect(findPushedBranchClearingFiles()).toEqual([...PUSHED_BRANCH_NULL_ALLOWED_IN]);
  });
});
