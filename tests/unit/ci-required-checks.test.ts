import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A job's `name:` in a workflow file IS its branch-protection status-check
 * context. Renaming or removing one silently desynchronizes `main`'s required
 * check list: the old context stops reporting, so every PR sits forever on
 * "Expected - Waiting for status to be reported" and cannot merge through the
 * normal gate. Nothing in CI catches that, because CI itself is green.
 *
 * This bit during the 2026-08-29 CI consolidation, which merged the `Lint
 * (ESLint)` / `Type check (tsc)` / `Build (production bundle)` jobs into one
 * `Checks (lint, typecheck, build)` job and had to update branch protection in
 * the same change.
 *
 * So this test pins the contract in BOTH directions:
 *   1. Every context that main requires still exists as a job `name:`.
 *   2. Every always-on job is explicitly classified as required or not, so
 *      adding a job forces a conscious decision about whether it should gate.
 *
 * When this test fails, update the list below AND main's branch protection
 * together:
 *   gh api repos/Kangentic/kangentic/branches/main/protection   # snapshot first
 *   gh api -X PATCH repos/Kangentic/kangentic/branches/main/protection/required_status_checks \
 *     -f 'checks[][context]=<new name>' ...
 */

const REPO_ROOT = join(__dirname, '..', '..');

/**
 * The status-check contexts branch protection requires on `main`, minus `cla`
 * (which is owned by cla.yml, a separate `pull_request_target` workflow that
 * never appears in a ci.yml run's own job list).
 *
 * Verified against the live API on 2026-08-29.
 */
const REQUIRED_CONTEXTS_FROM_CI = [
  'Checks (lint, typecheck, build)',
  'Unit tests (Vitest)',
  'UI tests (Playwright)',
  'E2E tests (Electron)',
];

/**
 * Jobs that deliberately do NOT gate: the sharded matrices. Their names carry
 * `${{ matrix... }}` templates, so they could never be stable contexts anyway.
 * Each tier gates through its thin `needs`-gated summary job above instead.
 */
const DELIBERATELY_NOT_REQUIRED = [
  'Unit Test (${{ matrix.shardIndex }}/${{ matrix.shardTotal }})',
  'UI Test (${{ matrix.shardIndex }}/${{ matrix.shardTotal }})',
  'E2E Test (${{ matrix.shardIndex }}/${{ matrix.shardTotal }})',
];

function readWorkflow(file: string): string {
  return readFileSync(join(REPO_ROOT, '.github', 'workflows', file), 'utf8');
}

/**
 * Collect every top-level job's `name:` value. Deliberately a line scan rather
 * than a YAML parse: no YAML parser is a declared dependency of this repo, and
 * the shape being asserted (two indent levels, one `name:` per job) is fixed by
 * the Actions schema.
 */
function jobNames(source: string): string[] {
  const names: string[] = [];
  const lines = source.split(/\r?\n/);
  let insideJob = false;
  for (const line of lines) {
    if (/^ {2}[A-Za-z_][\w-]*:\s*$/.test(line)) {
      insideJob = true;
      continue;
    }
    if (/^\S/.test(line)) insideJob = false;
    if (!insideJob) continue;
    const nameMatch = /^ {4}name:\s*(.+?)\s*$/.exec(line);
    if (nameMatch) {
      names.push(nameMatch[1].replace(/^["']|["']$/g, ''));
      insideJob = false;
    }
  }
  return names;
}

describe('CI status-check contexts stay in sync with branch protection', () => {
  const ciNames = jobNames(readWorkflow('ci.yml'));

  it('finds every job in ci.yml', () => {
    // Guards the line scan itself: if the parse silently stopped matching, every
    // other assertion here would vacuously pass.
    expect(ciNames.length).toBe(
      REQUIRED_CONTEXTS_FROM_CI.length + DELIBERATELY_NOT_REQUIRED.length,
    );
  });

  it.each(REQUIRED_CONTEXTS_FROM_CI)(
    'still defines the required context %s',
    (context) => {
      expect(ciNames).toContain(context);
    },
  );

  it('classifies every ci.yml job as required or deliberately not required', () => {
    const classified = new Set([
      ...REQUIRED_CONTEXTS_FROM_CI,
      ...DELIBERATELY_NOT_REQUIRED,
    ]);
    const unclassified = ciNames.filter((name) => !classified.has(name));
    expect(unclassified).toEqual([]);
  });

  it('keeps the cla context in its own workflow', () => {
    // `cla` is required on main but lives in cla.yml, which is why a job count
    // taken from a ci.yml run is always one short of the real concurrency load.
    expect(readWorkflow('cla.yml')).toMatch(/^\s{2}cla:\s*$/m);
  });
});
