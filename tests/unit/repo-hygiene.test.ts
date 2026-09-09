import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Open-source repo hygiene artifacts that nothing else validates. They live
 * outside `src/`, so no typecheck, lint rule, or existing test touches them, and
 * each one fails silently: a Code of Conduct with the Contributor Covenant's
 * `[INSERT CONTACT METHOD]` placeholder still renders fine on GitHub, and a
 * Dependabot config with a typo'd ecosystem name is simply ignored.
 *
 * The CodeQL assertion is the one that carries real weight. See its own comment.
 *
 * Deliberately a line scan rather than a YAML parse, matching
 * ci-required-checks.test.ts: no YAML parser is a direct dependency of this
 * repo, and the shapes asserted here are single keys at a fixed indent.
 */

const REPO_ROOT = join(__dirname, '..', '..');

/**
 * The role address. A personal address here would be a `no-personal-info.md`
 * violation in a public repo, and the Covenant ships with a placeholder that has
 * to be replaced by hand, so this pins the one correct value rather than merely
 * asserting that some email is present.
 */
const CONTACT_ADDRESS = 'support@kangentic.com';

/** Drop full-line comments so a file's own prose cannot satisfy a key scan. */
function stripComments(source: string): string[] {
  return source.split('\n').filter((line) => !/^\s*#/.test(line));
}

describe('CODE_OF_CONDUCT.md', () => {
  const codeOfConductPath = join(REPO_ROOT, 'CODE_OF_CONDUCT.md');

  it('exists at the repo root', () => {
    // GitHub's community profile only detects the root, .github/ and docs/.
    // Root is the choice here: docs/ is mirrored to the marketing website.
    expect(
      existsSync(codeOfConductPath),
      'CODE_OF_CONDUCT.md must stay at the repo root so GitHub detects it.',
    ).toBe(true);
  });

  it('does not ship the Covenant placeholder', () => {
    expect(
      readFileSync(codeOfConductPath, 'utf8'),
      'The Contributor Covenant placeholder was never filled in.',
    ).not.toContain('INSERT CONTACT METHOD');
  });
});

/**
 * Three files route reports to the same role address, and this diff put it in
 * two of them. A stale address in any one sends a report nowhere, and none of
 * the three is read often enough for that to surface on its own.
 */
describe('report routing', () => {
  it.each(['CODE_OF_CONDUCT.md', 'CONTRIBUTING.md', 'SECURITY.md'])(
    '%s routes reports to the role address',
    (fileName) => {
      expect(
        readFileSync(join(REPO_ROOT, fileName), 'utf8'),
        `${fileName} must route reports to ${CONTACT_ADDRESS}.`,
      ).toContain(CONTACT_ADDRESS);
    },
  );
});

describe('.github/dependabot.yml', () => {
  const dependabotPath = join(REPO_ROOT, '.github', 'dependabot.yml');

  it('exists and declares the github-actions ecosystem', () => {
    expect(existsSync(dependabotPath), '.github/dependabot.yml is missing.').toBe(true);

    const lines = stripComments(readFileSync(dependabotPath, 'utf8'));
    const declaresActions = lines.some((line) =>
      /^\s*-?\s*package-ecosystem:\s*["']?github-actions["']?\s*$/.test(line),
    );

    // A misspelled ecosystem is accepted by the file and then silently does
    // nothing, so the value is what gets pinned, not just the key.
    expect(
      declaresActions,
      'Dependabot must declare the `github-actions` ecosystem. npm is deliberately excluded; see the file header.',
    ).toBe(true);
  });

  it('groups its updates into a single PR', () => {
    const lines = stripComments(readFileSync(dependabotPath, 'utf8'));

    // Ungrouped bumps open one PR each, and every Dependabot PR fires the full
    // 21-job gate against a ~20-job account-wide cap.
    expect(
      lines.some((line) => /^\s*groups:\s*$/.test(line)),
      'Keep the `groups:` block: ungrouped action bumps open a PR each, and each one runs the whole CI gate.',
    ).toBe(true);

    // `groups:` on its own is satisfied by a group that matches nothing. The
    // catch-all pattern is what actually collapses every bump into one PR, so
    // narrowing it puts the unmatched remainder back on the gate one PR at a
    // time while the assertion above stays green.
    expect(
      lines.some((line) => /^\s*-\s*["']?\*["']?\s*$/.test(line)),
      'Keep the catch-all `- "*"` pattern under `groups:`. A narrowed pattern list leaves every action it does not match opening its own PR.',
    ).toBe(true);
  });
});

describe('.github/workflows/codeql.yml', () => {
  const codeqlPath = join(REPO_ROOT, '.github', 'workflows', 'codeql.yml');

  it('exists', () => {
    expect(existsSync(codeqlPath), 'CodeQL scanning workflow is missing.').toBe(true);
  });

  /**
   * THE LOAD-BEARING ONE.
   *
   * ci.yml's concurrency-budget block documents that the PR gate already runs 21
   * concurrent jobs against GitHub Free's ~20-job account-wide cap, and that 21
   * is a ceiling: at 22+ the earliest slot releaser becomes a ~70s unit shard,
   * so a queued UI shard starts that late and pushes the run past its ~226s
   * pole. CodeQL's two Analyze jobs on a PR would take it to 23.
   *
   * Adding a `pull_request:` trigger here is therefore a CI wall-clock
   * regression on every PR, forever, and it is a completely reasonable-looking
   * one-line edit. Nothing else would catch it: the workflow would go green.
   */
  it('has no pull_request trigger', () => {
    const lines = stripComments(readFileSync(codeqlPath, 'utf8'));
    const prTrigger = lines.find((line) => /^\s*pull_request(_target)?:/.test(line));

    expect(
      prTrigger,
      'CodeQL must not run on pull requests. It would add 2 jobs to a PR gate already at the documented 21-job ceiling (see the concurrency-budget block in ci.yml). Scanning runs on push to main and weekly instead.',
    ).toBeUndefined();
  });

  /**
   * The same 23-job breach as the guard above, through a different door.
   *
   * A `push:` trigger with no `branches:` filter fires on every topic-branch
   * push, and this repo pushes topic branches that already have an open PR as a
   * matter of course. Such a push runs ci.yml's 21-job PR gate and these two
   * Analyze jobs at the same time, so deleting one line here costs exactly what
   * adding a `pull_request:` trigger costs. Both of the other guards stay green
   * through that deletion: no `pull_request:` trigger appears, and `push:`
   * itself is still there. Deleting the whole trigger is a different edit, and
   * the guard below is the one that catches that.
   */
  it('scopes the push trigger to main', () => {
    const lines = stripComments(readFileSync(codeqlPath, 'utf8'));
    const branchFilter = lines.find((line) => /^\s*branches:/.test(line));

    expect(
      branchFilter,
      'The push trigger must keep its `branches:` filter. Without it CodeQL runs on every topic-branch push, stacking 2 Analyze jobs on top of the 21-job PR gate in ci.yml.',
    ).toBeDefined();

    expect(
      branchFilter ?? '',
      'Keep the push trigger scoped to main. A wildcard branch pattern fires CodeQL on every topic-branch push.',
    ).toMatch(/\bmain\b/);

    expect(
      branchFilter ?? '',
      'Keep the push trigger scoped to main. A wildcard branch pattern fires CodeQL on every topic-branch push.',
    ).not.toMatch(/\*/);
  });

  it('still runs on push to main and on a schedule', () => {
    // The guard above is satisfied by a workflow with no triggers at all, which
    // would disable scanning entirely while staying green.
    const lines = stripComments(readFileSync(codeqlPath, 'utf8'));

    expect(
      lines.some((line) => /^\s*push:/.test(line)),
      'CodeQL must still run on push to main, otherwise nothing is scanned after a merge.',
    ).toBe(true);

    expect(
      lines.some((line) => /^\s*schedule:/.test(line)),
      'Keep the weekly schedule: it catches newly published queries against unchanged code.',
    ).toBe(true);
  });
});
