import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// A gate that stops gating without saying so is worse than no gate, because it still reads as
// coverage. release.yml has been bitten by that twice.
//
// The subtle one is `always()`. GitHub normally skips a job when anything in its `needs:` failed,
// but `always()` overrides exactly that, so a job listed in `needs:` and NOT also named in the
// `if:` still runs when its dependency FAILED. release.yml carries `always()` on two jobs to
// tolerate the conditional create-tag, which means every future `needs:` entry added to them has
// to be repeated in the `if:` by hand. The comment above create-draft-release warns about this;
// this test is what makes the warning binding.
//
// The blunt one is a gate simply going missing: preflight-symbols exists because v0.37.0 and
// v0.38.0 both shipped with zero sourcemaps and zero native debug files, the KANGENTIC_SENTRY_TOKEN
// secret never having been created. The build no-opped in total silence and every job reported
// success. Deleting that job, or unhooking it from the draft, would restore that exact hole.
//
// Follows release-asset-manifest.test.ts in regex-extracting YAML rather than adding a parser
// (js-yaml is only transitively present, not a declared dependency).
//
// Tier: Unit.

const REPO_ROOT = path.resolve(__dirname, '../..');
const WORKFLOW_PATH = path.join(REPO_ROOT, '.github', 'workflows', 'release.yml');
const workflowSource = fs.readFileSync(WORKFLOW_PATH, 'utf8');

interface WorkflowJob {
  name: string;
  body: string;
  needs: string[];
  condition: string | null;
}

/**
 * Split the `jobs:` mapping into one entry per job. Job keys sit at exactly two spaces of
 * indentation, so a line matching /^ {2}([\w-]+):$/ starts a job and the body runs to the next
 * such line. Comment lines between jobs land in the PRECEDING job's body, which is harmless: no
 * assertion here reads a commented-out `needs:` or `if:`, since both are matched anchored to
 * their own four-space indentation.
 */
function parseJobs(source: string): WorkflowJob[] {
  const jobsBlock = source.slice(source.indexOf('\njobs:\n'));
  const lines = jobsBlock.split('\n');
  const jobs: WorkflowJob[] = [];
  let current: { name: string; lines: string[] } | null = null;

  for (const line of lines) {
    const header = line.match(/^ {2}([\w-]+):\s*$/);
    if (header) {
      if (current) jobs.push(buildJob(current));
      current = { name: header[1], lines: [] };
      continue;
    }
    if (current) current.lines.push(line);
  }
  if (current) jobs.push(buildJob(current));
  return jobs;
}

function buildJob(raw: { name: string; lines: string[] }): WorkflowJob {
  const body = raw.lines.join('\n');
  const needsMatch = body.match(/^ {4}needs:\s*(.+)$/m);
  const conditionMatch = body.match(/^ {4}if:\s*(.+)$/m);
  const needs = needsMatch
    ? needsMatch[1]
        .replace(/[[\]]/g, '')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
    : [];
  return { name: raw.name, body, needs, condition: conditionMatch ? conditionMatch[1] : null };
}

const jobs = parseJobs(workflowSource);

describe('release.yml job graph', () => {
  it('parses the jobs it is meant to guard (proves the regex still matches)', () => {
    const names = jobs.map((job) => job.name);
    expect(names).toContain('preflight-symbols');
    expect(names).toContain('create-draft-release');
    expect(names).toContain('release');
    expect(names).toContain('publish-release');
  });

  // buildJob reads `if:` with a single-line regex, so a condition folded onto
  // continuation lines (`if: >`, `if: |`) would parse as just the fold marker.
  // An always() job folded that way would stop being RECOGNIZED as always() and
  // drop out of the check below entirely - the silent no-op this rule exists to
  // stop, in the test that enforces it. Fail loudly instead of quietly skipping.
  it('keeps every if: on one line, which is what the condition regex can read', () => {
    for (const job of jobs) {
      if (job.condition === null) continue;
      expect(
        job.condition,
        `Job "${job.name}" folds its if: onto continuation lines. buildJob only reads the first `
          + 'line, so this job would silently stop being checked for always()/needs: parity. '
          + 'Put the condition back on one line, or teach buildJob to join continuations.',
      ).not.toMatch(/^[>|]/);
    }
  });

  // The load-bearing one. Without this, adding a dependency to an always() job reads as a gate
  // while doing nothing.
  it.each(jobs.filter((job) => job.condition?.includes('always()')).map((job) => [job.name, job]))(
    '%s uses always(), so every needs: entry is also named in its if:',
    (_name, job: WorkflowJob) => {
      expect(job.needs.length).toBeGreaterThan(0);
      for (const dependency of job.needs) {
        expect(
          job.condition,
          `Job "${job.name}" lists "${dependency}" in needs: but never references it in its if:. `
            + 'always() defeats the implicit "skip me if a dependency failed" behaviour, so this '
            + `job would still run when ${dependency} FAILED. Add `
            + `"&& needs.${dependency}.result == 'success'" (or the branch you actually want).`,
        ).toContain(`needs.${dependency}.result`);
      }
    },
  );

  it('gates the draft release on the symbol preflight, not just the build', () => {
    const draft = jobs.find((job) => job.name === 'create-draft-release');
    expect(draft).toBeDefined();
    // Gating the draft rather than only the matrix is what keeps a failed preflight from
    // leaving an orphaned draft release behind for a tag that never shipped.
    expect(draft?.needs).toContain('preflight-symbols');
  });

  it('keeps the symbol preflight required and free of an approval gate', () => {
    const preflight = jobs.find((job) => job.name === 'preflight-symbols');
    expect(preflight).toBeDefined();
    // It must actually fail rather than warn, or it is decoration.
    expect(preflight?.body).toContain('exit 1');
    expect(preflight?.body).toContain('KANGENTIC_SENTRY_TOKEN');
    // No environment: - a required reviewer or wait timer here would stall every release on an
    // approval gate, the same reason create-draft-release declares none.
    expect(preflight?.body).not.toMatch(/^ {4}environment:/m);
  });

  it('reaches the build matrix from the preflight, transitively', () => {
    const releaseJob = jobs.find((job) => job.name === 'release');
    // `release` does not name preflight-symbols directly; it inherits the gate through
    // create-draft-release, whose result its if: already requires. If that clause is ever
    // dropped, a missing token stops failing the build.
    expect(releaseJob?.needs).toContain('create-draft-release');
    expect(releaseJob?.condition).toContain("needs.create-draft-release.result == 'success'");
  });
});
