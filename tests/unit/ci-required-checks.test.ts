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
 * `Lint, Typecheck, Build` job and had to update branch protection in the same
 * change.
 *
 * So this test pins both directions of the WORKFLOW side of that contract:
 *   1. Every context that main requires still exists as a job `name:`.
 *   2. Every always-on job is explicitly classified as required or not, so
 *      adding a job forces a conscious decision about whether it should gate.
 *
 * What it CANNOT see is the protection side. REQUIRED_CONTEXTS_FROM_CI below is
 * a point-in-time snapshot of the live API, and nothing here re-reads that API,
 * so a context added or removed in the GitHub UI leaves this test green while
 * the snapshot quietly stops describing reality. Re-verify with the first
 * command below whenever branch protection is touched.
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
  'Lint, Typecheck, Build',
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

interface WorkflowJob {
  jobId: string;
  name: string | null;
}

/**
 * Collect every top-level job as its id plus its `name:` value, or null when the
 * job declares none. Deliberately a line scan rather than a YAML parse: no YAML
 * parser is a direct dependency of this repo, and adding one for a single test
 * file is not worth it when the shape being asserted (two indent levels, at most
 * one `name:` per job) is fixed by the Actions schema.
 *
 * Two things this scan has to get right, both of which it previously did not:
 *
 * 1. It starts only AFTER the top-level `jobs:` key. `on:`, `permissions:` and
 *    `concurrency:` also contain two-space keys ending in a bare colon
 *    (`push:`, `pull_request:`, `workflow_dispatch:`), which are shaped exactly
 *    like a job id.
 * 2. It records the job id independently of whether a `name:` follows. `name:`
 *    is optional in Actions, and a job without one uses its ID as the
 *    status-check context. Collecting names alone made such a job contribute
 *    nothing at all, so it passed both the count guard and the classification
 *    check while silently introducing an unclassified context - exactly the
 *    drift this file exists to prevent.
 */
function parseJobs(source: string): WorkflowJob[] {
  const jobs: WorkflowJob[] = [];
  const lines = source.split(/\r?\n/);
  let insideJobsBlock = false;
  let currentJob: WorkflowJob | null = null;
  for (const line of lines) {
    if (/^jobs:\s*$/.test(line)) {
      insideJobsBlock = true;
      continue;
    }
    if (!insideJobsBlock) continue;
    // Any other zero-indent key ends the jobs block.
    if (/^\S/.test(line)) {
      insideJobsBlock = false;
      currentJob = null;
      continue;
    }
    const jobIdMatch = /^ {2}([A-Za-z_][\w-]*):\s*$/.exec(line);
    if (jobIdMatch) {
      currentJob = { jobId: jobIdMatch[1], name: null };
      jobs.push(currentJob);
      continue;
    }
    if (currentJob === null || currentJob.name !== null) continue;
    const nameMatch = /^ {4}name:\s*(.+?)\s*$/.exec(line);
    if (nameMatch) {
      currentJob.name = nameMatch[1].replace(/^["']|["']$/g, '');
    }
  }
  return jobs;
}

// If any of these fail, update REQUIRED_CONTEXTS_FROM_CI / DELIBERATELY_NOT_REQUIRED
// above AND main's branch protection together - see the gh commands in this file's
// header comment. Changing only one of the two is what breaks merging.
describe('CI status-check contexts stay in sync with branch protection', () => {
  const ciJobs = parseJobs(readWorkflow('ci.yml'));
  const ciNames = ciJobs.map((job) => job.name);

  it('finds every job in ci.yml', () => {
    // Guards the line scan itself: if the parse silently stopped matching, every
    // other assertion here would vacuously pass. Reports the job ids it did find,
    // so a mismatch says WHICH job is unaccounted for rather than just a count.
    expect(ciJobs.map((job) => job.jobId)).toHaveLength(
      REQUIRED_CONTEXTS_FROM_CI.length + DELIBERATELY_NOT_REQUIRED.length,
    );
  });

  it('gives every ci.yml job an explicit name', () => {
    // `name:` is optional in Actions, and a job without one reports under its job
    // id instead. Such a job would contribute no name to the checks below and so
    // would slip past them entirely.
    const unnamed = ciJobs.filter((job) => job.name === null).map((job) => job.jobId);
    expect(unnamed).toEqual([]);
  });

  it.each(REQUIRED_CONTEXTS_FROM_CI)(
    'still defines the required context %s',
    (context) => {
      expect(ciNames).toContain(context);
    },
  );

  it('classifies every ci.yml job as required or deliberately not required', () => {
    const classified = new Set<string | null>([
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
