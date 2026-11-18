import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { WORKFLOWS_DIR, readWorkflow } from './helpers/read-workflow';

// Pins the checks that run on a schedule, off the pull request path. A scheduled run that nobody
// reads is not a check, and a credential check that tests other credentials than the release uses
// reads as coverage while covering nothing (.claude/rules/test-value.md, "A check off the PR path
// fails loudly somewhere"; .claude/rules/release-gates-fail-loudly.md).
//
// What a release loses if these go: signing-credentials.yml stops exercising a secret release.yml
// signs with, or signs against another account than the release does, and a dead credential is
// found inside the release matrix again, after the tag exists.
//
// It reads workflow text because the convention spans files (release.yml, the nightly, the release
// skill). Each collector is a pure function of the text it is given, and each red case mutates the
// real file in memory, so a matcher that stopped matching fails instead of passing.
//
// Tier: Unit.

const REPO_ROOT = path.resolve(__dirname, '../..');
const RELEASE_SKILL_PATH = path.join(REPO_ROOT, '.claude', 'skills', 'release', 'SKILL.md');
const SIGNING_NIGHTLY = 'signing-credentials.yml';

/** Secrets release.yml reads that the signing nightly does not exercise, each with why. */
const UNCHECKED_RELEASE_SECRETS: Record<string, string> = {
  GITHUB_TOKEN: 'GitHub issues it to each run. It has no end date to reach and nobody can revoke it between runs.',
};

/** Scheduled workflows the release skill does not read, each with why. */
const SCHEDULED_WITHOUT_RELEASE_READ: Record<string, string> = {
  'codeql.yml': 'Its findings land as code scanning alerts, which is where they are read. A run conclusion says nothing about them.',
};

const AZURE_SIGNING_LITERALS = ['AZURE_SIGNING_ENDPOINT', 'AZURE_SIGNING_ACCOUNT', 'AZURE_CERT_PROFILE'];

function replaceExactly(source: string, needle: string, replacement: string): string {
  if (!source.includes(needle)) {
    throw new Error(`The mutation needle ${JSON.stringify(needle)} is not in the source, so this red case would prove nothing.`);
  }
  return source.split(needle).join(replacement);
}

function workflowNames(): string[] {
  return fs.readdirSync(WORKFLOWS_DIR).filter((name) => /\.ya?ml$/.test(name)).sort();
}

/** The workflow without its comment lines, so a secret named in prose is not read as a use. */
function withoutCommentLines(source: string): string {
  return source.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');
}

/** Every secret the workflow reads by name. */
function secretsRead(source: string): Set<string> {
  return new Set([...withoutCommentLines(source).matchAll(/\bsecrets\.([A-Z][A-Z0-9_]*)/g)].map((match) => match[1]));
}

/** Release secrets the nightly neither reads nor is excused from, sorted. */
function releaseSecretsNotChecked(releaseSource: string, nightlySource: string, unchecked: Record<string, string>): string[] {
  const checked = secretsRead(nightlySource);
  return [...secretsRead(releaseSource)].filter((name) => !checked.has(name) && !(name in unchecked)).sort();
}

/** The value each Azure signing literal is set to, in a workflow that sets each exactly once. */
function azureSigningLiterals(source: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const name of AZURE_SIGNING_LITERALS) {
    const matches = [...withoutCommentLines(source).matchAll(new RegExp(`^\\s*${name}: (\\S+)$`, 'gm'))];
    if (matches.length !== 1) {
      throw new Error(`Expected ${name} to be set exactly once, found ${matches.length}.`);
    }
    values[name] = matches[0][1];
  }
  return values;
}

function hasTrigger(source: string, trigger: string): boolean {
  return new RegExp(`^ {2}${trigger}:`, 'm').test(source);
}

/** What makes the signing nightly unsafe or pointless to hold secrets, as a list of reasons. */
function signingNightlyProblems(source: string): string[] {
  const problems: string[] = [];
  for (const trigger of ['pull_request', 'pull_request_target', 'push']) {
    if (hasTrigger(source, trigger)) problems.push(`it runs on ${trigger}`);
  }
  if (!hasTrigger(source, 'schedule')) problems.push('it has no schedule');
  const body = withoutCommentLines(source);
  if (/uses: actions\/upload-artifact@/.test(body)) problems.push('it uploads an artifact');
  if (/uses: actions\/cache(\/save|\/restore)?@/.test(body)) problems.push('it writes or reads a cache');
  if (/^ {4}environment:/m.test(body)) problems.push('a job waits on an environment approval');
  return problems;
}

/** Scheduled workflows the release skill neither reads nor is excused from, sorted. */
function scheduledWorkflowsNobodyReads(
  workflows: Array<{ name: string; source: string }>,
  releaseSkill: string,
  excused: Record<string, string>,
): string[] {
  return workflows
    .filter((workflow) => hasTrigger(workflow.source, 'schedule'))
    .filter((workflow) => !releaseSkill.includes(`--workflow=${workflow.name}`) && !(workflow.name in excused))
    .map((workflow) => workflow.name)
    .sort();
}

const releaseSource = readWorkflow('release.yml');
const nightlySource = readWorkflow(SIGNING_NIGHTLY);
const releaseSkill = fs.readFileSync(RELEASE_SKILL_PATH, 'utf8').replace(/\r\n/g, '\n');
const allWorkflows = workflowNames().map((name) => ({ name, source: readWorkflow(name) }));

describe('the signing credentials nightly', () => {
  it('reads every secret release.yml reads', () => {
    // The matcher must see the secrets at all, or the comparison below passes on two empty sets.
    const released = secretsRead(releaseSource);
    for (const name of ['AZURE_CLIENT_SECRET', 'APPLE_CERTIFICATE_BASE64', 'APPLE_APP_SPECIFIC_PASSWORD', 'KANGENTIC_SENTRY_TOKEN']) {
      expect(released.has(name), `release.yml should read secrets.${name}`).toBe(true);
    }
    expect(
      releaseSecretsNotChecked(releaseSource, nightlySource, UNCHECKED_RELEASE_SECRETS),
      'release.yml reads a secret that signing-credentials.yml does not check. Add a check there, or list it in UNCHECKED_RELEASE_SECRETS with the reason.',
    ).toEqual([]);
  });

  it('goes red when the nightly stops reading one', () => {
    const withoutAzureSecret = replaceExactly(nightlySource, '${{ secrets.AZURE_CLIENT_SECRET }}', "''");
    expect(releaseSecretsNotChecked(releaseSource, withoutAzureSecret, UNCHECKED_RELEASE_SECRETS)).toEqual(['AZURE_CLIENT_SECRET']);
    const withNewReleaseSecret = `${releaseSource}\n          NEW_CHANNEL_KEY: \${{ secrets.NEW_CHANNEL_KEY }}\n`;
    expect(releaseSecretsNotChecked(withNewReleaseSecret, nightlySource, UNCHECKED_RELEASE_SECRETS)).toEqual(['NEW_CHANNEL_KEY']);
  });

  it('holds no secret the release does not use, and no stale excuse', () => {
    const released = secretsRead(releaseSource);
    for (const name of secretsRead(nightlySource)) {
      expect(released.has(name), `signing-credentials.yml reads secrets.${name}, which release.yml does not`).toBe(true);
    }
    for (const name of Object.keys(UNCHECKED_RELEASE_SECRETS)) {
      expect(released.has(name), `UNCHECKED_RELEASE_SECRETS lists ${name}, which release.yml no longer reads`).toBe(true);
    }
  });

  it('signs with the endpoint, account and profile the release signs with', () => {
    expect(azureSigningLiterals(nightlySource)).toEqual(azureSigningLiterals(releaseSource));
    const drifted = replaceExactly(nightlySource, 'AZURE_CERT_PROFILE: kangentic-signing', 'AZURE_CERT_PROFILE: another-profile');
    expect(azureSigningLiterals(drifted)).not.toEqual(azureSigningLiterals(releaseSource));
  });

  it('signs through the release hook, not a copy of it', () => {
    expect(withoutCommentLines(nightlySource)).toContain("require('./build/windowsSign.js').default(");
  });

  it('runs only on a schedule or by hand, and keeps nothing', () => {
    expect(signingNightlyProblems(nightlySource)).toEqual([]);
  });

  it('names each way it could leak or stall', () => {
    const onPullRequest = replaceExactly(nightlySource, '  workflow_dispatch:\n', '  workflow_dispatch:\n  pull_request:\n    branches: [main]\n');
    expect(signingNightlyProblems(onPullRequest)).toEqual(['it runs on pull_request']);
    const onPush = replaceExactly(nightlySource, '  workflow_dispatch:\n', '  workflow_dispatch:\n  push:\n    branches: [main]\n');
    expect(signingNightlyProblems(onPush)).toEqual(['it runs on push']);
    const uploading = `${nightlySource}      - uses: actions/upload-artifact@v7\n`;
    expect(signingNightlyProblems(uploading)).toEqual(['it uploads an artifact']);
    const gated = replaceExactly(nightlySource, '    runs-on: macos-latest\n', '    runs-on: macos-latest\n    environment: release-macos-arm64\n');
    expect(signingNightlyProblems(gated)).toEqual(['a job waits on an environment approval']);
    const unscheduled = replaceExactly(nightlySource, '  schedule:\n', '  not_a_schedule:\n');
    expect(signingNightlyProblems(unscheduled)).toEqual(['it has no schedule']);
  });
});

describe('scheduled workflows', () => {
  it('are each read by /release, or say why not', () => {
    // package-smoke is the known case. If the collector stopped seeing it, the list below is empty for the wrong reason.
    expect(hasTrigger(readWorkflow('package-smoke.yml'), 'schedule')).toBe(true);
    expect(
      scheduledWorkflowsNobodyReads(allWorkflows, releaseSkill, SCHEDULED_WITHOUT_RELEASE_READ),
      'A scheduled workflow is read by nothing. Have .claude/skills/release/SKILL.md read it with --workflow=<file>, or list it in SCHEDULED_WITHOUT_RELEASE_READ with the reason.',
    ).toEqual([]);
  });

  it('are caught when the release skill stops reading one', () => {
    const skillWithoutSigning = replaceExactly(releaseSkill, `--workflow=${SIGNING_NIGHTLY}`, '--workflow=something-else.yml');
    expect(scheduledWorkflowsNobodyReads(allWorkflows, skillWithoutSigning, SCHEDULED_WITHOUT_RELEASE_READ)).toEqual([SIGNING_NIGHTLY]);
    expect(scheduledWorkflowsNobodyReads(allWorkflows, releaseSkill, {})).toContain('codeql.yml');
  });

  it('hold no stale excuse', () => {
    for (const name of Object.keys(SCHEDULED_WITHOUT_RELEASE_READ)) {
      const workflow = allWorkflows.find((candidate) => candidate.name === name);
      expect(workflow, `SCHEDULED_WITHOUT_RELEASE_READ lists ${name}, which does not exist`).toBeDefined();
      expect(hasTrigger(workflow?.source ?? '', 'schedule'), `${name} is no longer scheduled`).toBe(true);
      expect(releaseSkill.includes(`--workflow=${name}`), `${name} is excused and also read by the release skill`).toBe(false);
    }
  });

  it('the release skill requires a green signing nightly before a tag', () => {
    expect(releaseSkill).toContain(`--workflow=${SIGNING_NIGHTLY} --event schedule`);
  });
});
