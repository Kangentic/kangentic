import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// A gate that stops gating without saying so is worse than no gate, because it still reads as
// coverage. release.yml has been bitten by that four times now. The first two shapes are below;
// the later describe blocks pin the published-release re-run (v0.39.0) and the two upgrade-gate
// baselines (v0.39.0 upgrading from itself, v0.39.x downgrading from v0.40.0).
//
// The subtle one is the status-check function. GitHub normally skips a job when anything in its
// `needs:` failed, but naming always(), cancelled(), or failure() in the `if:` replaces that
// implied success() gate, so a job listed in `needs:` and NOT also named in the `if:` still runs
// when its dependency FAILED. release.yml carries always() on two jobs to tolerate the conditional
// create-tag and `!cancelled()` on the two publish jobs, which means every future `needs:` entry
// added to any of the four has to be repeated in the `if:` by hand. The comment above
// create-draft-release warns about this; this test is what makes the warning binding.
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
  // A job folded that way would stop being RECOGNIZED as carrying a status
  // function and drop out of the check below entirely - the silent no-op this
  // rule exists to stop, in the test that enforces it. Fail loudly instead of
  // quietly skipping.
  it('keeps every if: on one line, which is what the condition regex can read', () => {
    for (const job of jobs) {
      if (job.condition === null) continue;
      expect(
        job.condition,
        `Job "${job.name}" folds its if: onto continuation lines. buildJob only reads the first `
          + 'line, so this job would silently stop being checked for status-function/needs: parity. '
          + 'Put the condition back on one line, or teach buildJob to join continuations.',
      ).not.toMatch(/^[>|]/);
    }
  });

  // GitHub implies success() on a job with no status-check function in its if:, and that implied
  // gate is what skips a job when a dependency failed. Naming ANY of always(), cancelled(), or
  // failure() replaces it, so every such job has to re-state each needs: entry by hand.
  // `!cancelled()` is the easy one to miss: it reads like a cancellation guard rather than a
  // dependency gate, but it defeats the implicit skip exactly the way always() does.
  const STATUS_FUNCTION_PATTERN = /\b(always|cancelled|failure)\(\)/;
  const selfGatedJobs = jobs.filter((job) => STATUS_FUNCTION_PATTERN.test(job.condition ?? ''));

  // An empty or shrunken filter would turn the it.each below into zero tests, which passes. The
  // four jobs that carry a status function are named here so dropping one from the workflow, or
  // a parse regression that stops recognizing one, fails rather than quietly reducing coverage.
  it('selects every job whose if: replaces the implied success() gate', () => {
    expect(selfGatedJobs.map((job) => job.name).sort()).toEqual([
      'create-draft-release',
      'publish-npm',
      'publish-release',
      'release',
    ]);
  });

  // The load-bearing one. Without this, adding a dependency to one of those jobs reads as a gate
  // while doing nothing.
  it.each(selfGatedJobs.map((job) => [job.name, job] as const))(
    '%s replaces the implied success() gate, so every needs: entry is also named in its if:',
    (_name, job: WorkflowJob) => {
      expect(job.needs.length).toBeGreaterThan(0);
      const statusFunction = job.condition?.match(STATUS_FUNCTION_PATTERN)?.[0];
      for (const dependency of job.needs) {
        expect(
          job.condition,
          `Job "${job.name}" lists "${dependency}" in needs: but never references it in its if:. `
            + `${statusFunction} defeats the implicit "skip me if a dependency failed" behaviour, `
            + `so this job would still run when ${dependency} FAILED. Add `
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

// The upgrade gates have picked a wrong baseline twice, in two directions. Through v0.39.0 they
// read /releases/latest, which returns the release being built the moment anything publishes it,
// so a re-run upgraded a version from ITSELF: dnf/apt install the same package twice, the version
// assertion passes, and the run reports green while testing nothing. Through v0.40.0 they took the
// newest published tag that was not their own, so re-running v0.39.1 after v0.40.0 had shipped
// baselined on v0.40.0 and ran 0.40.0 -> 0.39.1: apt refused the downgrade (red, and correct),
// while dnf downgraded without complaint and `rpm -q kangentic-0.39.1` passed (green, and wrong).
// That is what the 2026-09-10 tag scrub did to v0.39.0 and v0.39.1, and it recurs on any full
// re-run of an older tag, which the release skill prescribes for recovery.
//
// The baseline is now the newest published release whose version is numerically LOWER than the
// build's. The program is pinned whole below AND executed against fixtures, because a string pin
// proves only that the text did not change, not that the rule is the one the incident needs.
const BASELINE_PROGRAM =
  "'def ver: ltrimstr(\"v\") | split(\".\") | map(tonumber); "
  + '[.[] | select(.draft == false and .prerelease == false) | '
  + 'select(.tag_name | test("^v[0-9]+[.][0-9]+[.][0-9]+$")) | '
  + 'select((.tag_name | ver) < ($self | ver))] | max_by(.tag_name | ver) | .tag_name // empty\'';

const IGNORED_TAGS_PROGRAM =
  "'[.[] | select(.draft == false and .prerelease == false) | "
  + 'select(.tag_name | test("^v[0-9]+[.][0-9]+[.][0-9]+$") | not) | .tag_name] | join(" ")\'';

const upgradeSteps = [
  ['rpm', stepBody('release', 'Verify rpm upgrades from the previous release')],
  ['deb', stepBody('release', 'Verify deb upgrades from the previous release')],
] as const;

describe('release.yml upgrade gates baseline on the newest release OLDER than the build', () => {
  it.each(upgradeSteps)('the %s gate resolves the baseline by version, below this build\'s own', (_name, body) => {
    // Resolved from the built artifact's version, so the comparison holds however the ref is spelled.
    expect(body).toContain('--arg self "v$new_version"');
    // The whole jq program, not a clause of it. `.draft == false` keeps the release under
    // construction out of its own baseline on the normal path, `.prerelease` keeps a beta out, the
    // regex gate keeps `tonumber` off a tag it cannot parse, `< ($self | ver)` is the older-than
    // rule this block exists for, and `max_by` is what makes it the NEWEST whatever order the API
    // lists releases in. Asserting fragments lets any of the others be dropped while the test
    // stays green.
    expect(body).toContain(BASELINE_PROGRAM);
  });

  it.each(upgradeSteps)('the %s gate names the published tags it could not compare', (_name, body) => {
    // The regex gate above drops a tag it cannot parse rather than aborting on it. Dropping is
    // the right call, and it is also exactly the kind of silent narrowing this rule forbids, so
    // the step has to say which tags it ignored, on every run where it ignored any.
    expect(body).toContain(IGNORED_TAGS_PROGRAM);
    expect(body).toContain('Ignoring published release(s) whose tag is not a plain vX.Y.Z');
  });

  it.each(upgradeSteps)('the %s gate rejects a built version it cannot compare numerically', (_name, body) => {
    // The API tags get the regex gate; the build's own version cannot be dropped the same way,
    // because dropping it would leave nothing to compare against and skip the gate. It is
    // asserted instead. Without this the step still fails on a non-triple version, but on jq's
    // raw "Cannot parse" text, which names neither the version nor the step that produced it.
    expect(body).toContain("grep -qE '^[0-9]+\\.[0-9]+\\.[0-9]+$'");
    // Anchored to the echo line, not the bare phrase, for the same reason as the
    // /releases/latest test below: the comments around this guard discuss the shape it rejects,
    // and a phrase-only pin would stay green against a step that kept the comment and lost the
    // exit.
    expect(body).toMatch(/echo "::error::Built version '\$new_version' is not a plain X\.Y\.Z/);
  });

  it.each(upgradeSteps)('the %s gate reads the release LIST, not /releases/latest', (_name, body) => {
    // Anchored to the request line rather than the whole body: the comments above each step
    // explain the old endpoint on purpose, and must not trip this.
    expect(body).toMatch(/releases\?per_page=100"\)/);
    expect(body).not.toMatch(/releases\/latest"\)/);
  });

  it.each(upgradeSteps)('the %s gate still fails rather than skips on a transport failure', (_name, body) => {
    // Only "no published release older than this one" may skip. A 403 from the shared runner IP
    // used to be the way this went quiet.
    expect(body).toContain('Refusing to skip the upgrade check on a transport failure');
    expect(body).toMatch(/No published release older than v\$new_version/);
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

// The pins above prove the text. This block proves the rule, by running the program the workflow
// actually carries through a real jq against release lists shaped like the incidents. jq is
// preinstalled on ubuntu-latest, where CI's unit job runs (and where release.yml itself calls it
// with no install step); a developer machine without it gets the skip notice below rather than a
// silent pass.
const HAS_JQ = (() => {
  try {
    execFileSync('jq', ['--version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
})();

const RUNNING_ON_CI = Boolean(process.env.CI);

interface ReleaseRow {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
}

function published(tagName: string): ReleaseRow {
  return { tag_name: tagName, draft: false, prerelease: false };
}

/**
 * The single-quoted jq program out of a step's `<assignment>jq -r ... '<program>' /tmp/releases.json)`
 * command substitution, with the bash quotes stripped so it can be handed to jq as one argument.
 *
 * Throws on a miss, and throws on a program missing its load-bearing operator, for the same reason
 * stepBody throws: a stale regex that returned '' or a fragment would hand jq an identity filter,
 * and an identity filter over these fixtures prints something rather than failing outright.
 */
function extractProgram(body: string, assignment: string, loadBearingOperator: string): string {
  const escaped = assignment.replace(/[$()]/g, '\\$&');
  const match = body.match(new RegExp(`${escaped}jq -r[^\\n]*\\\\\\n\\s*'([^']+)' \\\\\\n\\s*/tmp/releases\\.json\\)`));
  if (!match) {
    throw new Error(`Could not find the ${assignment} jq program in the step body; the extraction regex is stale.`);
  }
  if (!match[1].includes(loadBearingOperator)) {
    throw new Error(`The ${assignment} jq program no longer contains "${loadBearingOperator}"; the extraction caught a fragment.`);
  }
  return match[1];
}

function runJq(program: string, releases: ReleaseRow[], jqArguments: string[]): string {
  return execFileSync('jq', ['-r', ...jqArguments, program], {
    input: JSON.stringify(releases),
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

describe.runIf(HAS_JQ)('release.yml upgrade baseline program, executed', () => {
  const programs = upgradeSteps.map(([name, body]) => [
    name,
    extractProgram(body, 'prev_tag=$(', 'max_by'),
    extractProgram(body, 'ignored_tags=$(', '| not'),
  ] as const);

  const baselineFor = (program: string, self: string, releases: ReleaseRow[]): string =>
    runJq(program, releases, ['--arg', 'self', self]);

  it.each(programs)('the %s gate re-run of v0.39.1 after v0.40.0 shipped upgrades FROM v0.39.0', (_name, program) => {
    // The incident. The old rule returned v0.40.0 here and the gate downgraded.
    const releases = [published('v0.40.0'), published('v0.39.1'), published('v0.39.0')];
    expect(baselineFor(program, 'v0.39.1', releases)).toBe('v0.39.0');
  });

  it.each(programs)('the %s gate normal path still picks the newest shipped release', (_name, program) => {
    const releases = [published('v0.40.0'), published('v0.39.1'), published('v0.39.0')];
    expect(baselineFor(program, 'v0.41.0', releases)).toBe('v0.40.0');
  });

  it.each(programs)('the %s gate compares versions numerically, not as text', (_name, program) => {
    // "v0.9.1" sorts ABOVE "v0.10.0" as a string, which would make v0.10.0 skip its upgrade check
    // with "no older release" while nine of them exist.
    const releases = [published('v0.9.1'), published('v0.9.0')];
    expect(baselineFor(program, 'v0.10.0', releases)).toBe('v0.9.1');
  });

  it.each(programs)('the %s gate does not depend on the order the API lists releases in', (_name, program) => {
    // The documented recovery (gh release delete, then a full re-run) re-creates the release
    // object for an OLD tag, and the list endpoint orders by object creation, so that old
    // release sits first. `[0]` would have handed it to the next build as the baseline.
    const releases = [published('v0.39.0'), published('v0.40.0'), published('v0.39.1')];
    expect(baselineFor(program, 'v0.41.0', releases)).toBe('v0.40.0');
  });

  it.each(programs)('the %s gate skips drafts, prereleases, and tags it cannot parse, and names the last', (_name, program, ignoredProgram) => {
    // v0.41.0-rc1 carries no prerelease flag and protocol-v1.2.0 is not a desktop version at all.
    // Either would throw inside tonumber and abort the step if the regex gate were not in front of
    // it. Both are reported by the companion program rather than dropped in silence.
    const releases = [
      { tag_name: 'v0.41.0', draft: true, prerelease: false },
      { tag_name: 'v0.40.1', draft: false, prerelease: true },
      published('v0.41.0-rc1'),
      published('protocol-v1.2.0'),
      published('v0.40.0'),
      published('v0.39.1'),
    ];
    expect(baselineFor(program, 'v0.41.0', releases)).toBe('v0.40.0');
    expect(runJq(ignoredProgram, releases, [])).toBe('v0.41.0-rc1 protocol-v1.2.0');
  });

  it.each(programs)('the %s gate returns nothing for the first release ever, which is the one green skip', (_name, program) => {
    const releases = [published('v0.40.0'), published('v0.1.0')];
    expect(baselineFor(program, 'v0.1.0', releases)).toBe('');
  });
});

describe.runIf(!HAS_JQ)('release.yml upgrade baseline program, executed (skipped)', () => {
  it('skipped - jq is not on PATH; CI runs this on ubuntu-latest where it is preinstalled', () => {
    expect(HAS_JQ).toBe(false);
  });
});

// A local machine without jq may skip the executed block; CI may not. The comment above HAS_JQ
// rests on ubuntu-latest shipping jq, and if that ever stops being true the six behavioural cases
// go uncollected and the file still reports green - the "reads as coverage but is not" shape this
// whole file exists to forbid. Nothing above can catch it, because the only assertion on HAS_JQ
// lives in the branch that runs when it is already false. This is the check that makes the
// comment binding, for the same reason the four-job list above pins its own filter.
describe.runIf(RUNNING_ON_CI)('release.yml upgrade baseline program, executed (CI invariant)', () => {
  it('finds jq on PATH, so CI never skips the executed block', () => {
    expect(HAS_JQ).toBe(true);
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

  // extractProgram feeds the executed block, so it carries the same hazard: returning '' or a
  // fragment on a stale regex would hand jq an identity filter and let the rule's own test pass
  // against the wrong program.
  it('extractProgram throws on an assignment that is not in the step', () => {
    expect(() => extractProgram(upgradeSteps[0][1], 'renamed_away=$(', 'max_by')).toThrow(
      /extraction regex is stale/
    );
  });

  it('extractProgram throws when the program it found lacks its load-bearing operator', () => {
    // A body shaped exactly like the workflow's, with the program cut down to a fragment that
    // would still run under jq (and print every tag name, rather than nothing).
    const fragmentBody = [
      '          prev_tag=$(jq -r --arg self "v$new_version" \\',
      "            '[.[] | .tag_name][0] // empty' \\",
      '            /tmp/releases.json)',
    ].join('\n');
    expect(() => extractProgram(fragmentBody, 'prev_tag=$(', 'max_by')).toThrow(
      /caught a fragment/
    );
  });
});
