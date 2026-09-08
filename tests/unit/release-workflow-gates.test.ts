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

/**
 * One step's block out of a job body. Steps open with `      - name: <name>` at six spaces and
 * run to the next line at that same indentation, so the returned text carries the step's `run:`
 * script and nothing from its neighbours.
 *
 * The end boundary is two patterns, not one. A step normally ends at the next step, but the LAST
 * step of a job has none: parseJobs leaves the comment block that introduces the next job inside
 * the previous job's body (harmless for its own indentation-anchored matches, not for this), so
 * an end test looking only for `      - ` runs off the end and swallows that header. A non-empty
 * line at exactly two spaces is the next job, and stops the block too.
 *
 * Throws rather than returning empty on a miss: a renamed step would otherwise silently turn
 * every assertion below into `expect('').not.toContain(...)`, which passes.
 */
function stepBody(jobName: string, stepName: string): string {
  const job = jobs.find((candidate) => candidate.name === jobName);
  if (!job) throw new Error(`release.yml has no job named ${jobName}`);
  const lines = job.body.split('\n');
  const startIndex = lines.findIndex((line) => line === `      - name: ${stepName}`);
  if (startIndex === -1) {
    throw new Error(`Job ${jobName} has no step named "${stepName}" (was it renamed?)`);
  }
  const rest = lines.slice(startIndex + 1);
  const endOffset = rest.findIndex((line) => /^ {6}- /.test(line) || /^ {2}\S/.test(line));
  const block = rest.slice(0, endOffset === -1 ? rest.length : endOffset).join('\n');
  // The `throw` above covers a bad START. This covers a bad END: if the boundary regex ever stops
  // matching how a step opens, the block silently swallows its neighbours and every `not.toContain`
  // below keeps passing against the wrong text.
  if (block.includes('- name:')) {
    throw new Error(`Step "${stepName}" in ${jobName} absorbed a following step; the boundary regex is stale.`);
  }
  return block;
}

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

// v0.39.0 sat published and empty because its draft was published by hand while the three
// platform builds were still running. electron-builder uploads only into a DRAFT, so it skipped
// all 11 artifacts with `existing type not compatible with publishing type` and every build still
// exited 0. Two shapes in release.yml let that reach the end of the run, and both are pinned here.
describe('release.yml cannot build into a published release', () => {
  const draftStep = stepBody('create-draft-release', 'Create the draft release if absent');

  it('fails on a published-but-incomplete release instead of reusing it', () => {
    // The old code reused ANY existing release for the tag. That is the branch that let a
    // hand-published release swallow every upload, so the step must be able to fail.
    expect(draftStep).toContain('exit 1');
    // "Complete" has exactly one definition, the same one publish-release trusts. An asset
    // count reimplemented in bash here could drift away from the manifest.
    expect(draftStep).toContain('scripts/verify-release-assets.js');
    // The error has to name the recovery, since the symptom shows up three jobs downstream.
    expect(draftStep).toContain('gh release delete');
  });

  it('still reuses a draft, and still short-circuits a finished release', () => {
    // Both green paths are load-bearing: reusing a draft is the normal re-run, and passing over
    // an already-complete published release is the idempotent backfill publish-npm also allows.
    expect(draftStep).toMatch(/select\(\.draft\)/);
    expect(draftStep).toContain('A draft release already exists');
    expect(draftStep).toContain('carries every expected asset');
  });

  it('reports the create path too, not only the branches that found something', () => {
    // The other three branches echo because they are explaining a decision. Creating the draft
    // is the branch with no natural reason to say anything, so it is the one whose line goes
    // missing - and release-gates-fail-loudly.md requires a step that can no-op to state which
    // way it went, on every run.
    expect(draftStep).toContain('Created the draft release for $tag.');
  });

  it('names the three causes rather than asserting the destructive one', () => {
    // verify-release-assets.js exits 1 for an unreachable API and for a tag resolving to several
    // release objects, not only for a verified-incomplete one. The old single message asserted
    // "incomplete, so delete this tag", which is wrong in two of the three cases and wrong in
    // the direction that destroys a good release.
    expect(draftStep).toContain('cannot tell the three causes apart');
    expect(draftStep).toContain('re-run this workflow and delete nothing');
    expect(draftStep).toContain('delete the EXTRAS');
  });
});

// The upgrade gates resolved their baseline through /releases/latest, which returns the release
// being built the moment anything publishes it. The gate then upgraded a version from ITSELF:
// dnf/apt install the same package twice, the version assertion passes, and the run reports green
// while testing nothing. That fires on any re-run of a finished release, with no manual click.
describe('release.yml upgrade gates never upgrade a version from itself', () => {
  const upgradeSteps = [
    ['rpm', stepBody('release', 'Verify rpm upgrades from the previous release')],
    ['deb', stepBody('release', 'Verify deb upgrades from the previous release')],
  ] as const;

  it.each(upgradeSteps)('the %s gate excludes this build\'s own tag from the baseline', (_name, body) => {
    // Resolved from the built artifact's version, so the exclusion holds however the ref is spelled.
    expect(body).toContain('--arg self "v$new_version"');
    // The whole jq program, not the exclusion clause alone. `.draft == false` is what keeps the
    // release under construction out of its own baseline on the normal path, `.prerelease` keeps
    // a beta out, and `[0]` is what makes it the NEWEST rather than some other match. Asserting
    // fragments lets any of the others be dropped while the test stays green.
    expect(body).toContain(
      "'[.[] | select(.draft == false and .prerelease == false and .tag_name != $self)][0].tag_name // empty'"
    );
  });

  it.each(upgradeSteps)('the %s gate reads the release LIST, not /releases/latest', (_name, body) => {
    // Anchored to the request line rather than the whole body: the comments above each step
    // explain the old endpoint on purpose, and must not trip this.
    expect(body).toMatch(/releases\?per_page=100"\)/);
    expect(body).not.toMatch(/releases\/latest"\)/);
  });

  it.each(upgradeSteps)('the %s gate still fails rather than skips on a transport failure', (_name, body) => {
    // Only "no published release other than this one" may skip. A 403 from the shared runner IP
    // used to be the way this went quiet.
    expect(body).toContain('Refusing to skip the upgrade check on a transport failure');
    expect(body).toMatch(/No published release other than v\$new_version/);
  });

  it.each(upgradeSteps)('the %s gate says how many releases it saw when it skips', (_name, body) => {
    // The skip is the one green path here, and an empty filter result has two causes the step
    // cannot separate: no baseline exists yet, or the filter is broken against a full history.
    // jq answers null for an unknown field rather than erroring, so a later typo in .draft or
    // .tag_name would skip every release from then on and still report green. The count is what
    // makes the log able to tell them apart.
    expect(body).toContain("jq 'length' /tmp/releases.json");
  });
});

// Every assertion above reaches its subject through stepBody, so a stepBody that silently returns
// the wrong text turns this whole file into passes that check nothing. Its two guards exist for
// that, which means the guards themselves are worth a test.
describe('stepBody keeps the assertions above honest', () => {
  it('throws on a step name that is no longer in the workflow', () => {
    // The failure this prevents: a renamed step yields no match, stepBody hands back '', and
    // every toContain above it passes against the empty string.
    expect(() => stepBody('create-draft-release', 'Renamed away at some point')).toThrow(
      /was it renamed/
    );
  });

  it('ends a step body at the next step instead of absorbing it', () => {
    // The rpm gate is immediately followed by the deb gate, so these two are what a stale
    // boundary regex would fuse. Fused, each `not.toContain` in this file would be asserting
    // against both steps at once and would still pass.
    expect(stepBody('release', 'Verify rpm upgrades from the previous release')).not.toContain(
      'Verify deb upgrades'
    );
  });

  it('ends the LAST step of a job at the next job, not at the end of the body', () => {
    // The case the `- name:` guard structurally cannot catch. The deb gate is the last step in
    // `release`, so there is no following step to stop at, and the text that follows it is
    // publish-release's comment header - which contains no `- name:` for the guard to see.
    // Unbounded, every negative assertion on the deb gate is quietly reading another job.
    expect(stepBody('release', 'Verify deb upgrades from the previous release')).not.toContain(
      'Publish the draft release'
    );
  });
});
