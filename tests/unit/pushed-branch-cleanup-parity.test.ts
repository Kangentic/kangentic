import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * `tasks.pushed_branch` and `tasks.resolved_base_branch` both describe the
 * branch identity of a task's worktree: the branch its work was actually pushed
 * to, and the base it was actually cut from. The PR ladder reads both as
 * anchors, so both have to be discarded wherever branch identity is discarded.
 *
 * The hazard is specific: a cleanup path that nulls `branch_name` but leaves
 * these set keeps a live PR anchor on a task whose worktree and branch were just
 * reclaimed, so the next resolve re-links a PR to a task that no longer has any
 * work. There are five such sites today (task-cleanup, transition-engine,
 * resource-cleanup, resume-suspended, auto-spawn), and a sixth is exactly the
 * kind of thing added without reading this file.
 *
 * Deliberately keyed on `branch_name: null` rather than on the cleanup
 * functions: `deleteTaskWorktree` nulls `worktree_path` on the Done move but
 * PRESERVES `branch_name`, and it must preserve these two as well, because
 * resolving a merged PR after the worktree is reclaimed is the whole point of
 * them. "Wherever the branch goes" is the correct trigger, not "wherever the
 * worktree goes".
 *
 * This is a static scan rather than a behavioural test because the sites are
 * spread across five modules with different callers, and the invariant is about
 * every write, not any one code path.
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
const BRANCH_IDENTITY_COLUMNS = ['pushed_branch', 'resolved_base_branch'];

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

/** Every `branch_name: null` write in the scanned tree, with its literal resolved. */
function findBranchClearingWrites(): Array<{ file: string; literal: string | null }> {
  const writes: Array<{ file: string; literal: string | null }> = [];
  for (const filePath of collectSourceFiles(path.join(REPO_ROOT, SCAN_DIR))) {
    const source = fs.readFileSync(filePath, 'utf8');
    for (const match of source.matchAll(CLEARS_BRANCH_NAME)) {
      writes.push({
        file: path.relative(REPO_ROOT, filePath).replace(/\\/g, '/'),
        literal: enclosingObjectLiteral(source, match.index),
      });
    }
  }
  return writes;
}

describe('branch-identity columns are cleared wherever branch_name is cleared', () => {
  it.each(BRANCH_IDENTITY_COLUMNS)('every task update that nulls branch_name also nulls %s', (column) => {
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
      `These task updates discard the local branch but keep ${column}, which leaves a live PR `
      + `anchor on a task whose worktree and branch were just reclaimed. Add \`${column}: null\` `
      + 'to each:\n' + offenders.join('\n'),
    ).toEqual([]);
  });

  it('finds the known cleanup sites, so the scan cannot silently match nothing', () => {
    // Guards the guard. The scan is only as good as its trigger, so a refactor
    // that renamed the column or moved every site behind a helper would
    // otherwise leave the test above passing over zero writes.
    expect(findBranchClearingWrites()).toHaveLength(5);
  });
});
