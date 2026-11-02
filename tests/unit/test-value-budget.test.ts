import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// The mechanical half of .claude/rules/test-value.md. The web demo job took ci.yml past GitHub Free's
// job cap with nothing to notice, and seven jobs queued for 85-208s on every PR until the 2026-11-02
// audit found it. These pins are what would have failed.
//
// The collectors read the YAML with line-anchored regexes, like ci-workflow-hygiene.test.ts, because
// js-yaml is only a transitive dependency. Each one throws on a shape it cannot read, and the red
// cases mutate a real workflow in memory, so a collector that stops matching fails instead of passing.
//
// Tier: Unit.

const REPO_ROOT = path.resolve(__dirname, '../..');
const WORKFLOWS_DIR = path.join(REPO_ROOT, '.github', 'workflows');

/** GitHub Free allows 20 concurrent jobs. The CLA check frees its slot in ~10-17s, so one over holds. */
const PR_JOB_CEILING = 21;
const MACOS_JOB_CAP = 5;

/** Workflows that run on a push to main with no tested-tree gate, each with why. */
const PUSH_WITHOUT_GATE_ALLOWED: Record<string, string> = {
  'codeql.yml': 'Scanning never ran on the PR, so the push is the only scan the merged tree gets.',
};

function readWorkflow(name: string): string {
  return fs.readFileSync(path.join(WORKFLOWS_DIR, name), 'utf8').replace(/\r\n/g, '\n');
}

function workflowNames(): string[] {
  return fs.readdirSync(WORKFLOWS_DIR).filter((name) => /\.ya?ml$/.test(name)).sort();
}

function replaceExactly(source: string, needle: string, replacement: string): string {
  if (!source.includes(needle)) {
    throw new Error(`The mutation needle ${JSON.stringify(needle)} is not in the source, so this red case would prove nothing.`);
  }
  return source.split(needle).join(replacement);
}

interface Job {
  id: string;
  body: string;
}

function parseJobs(source: string): Job[] {
  const start = source.indexOf('\njobs:\n');
  if (start === -1) throw new Error('This workflow has no top-level jobs: key.');
  return source
    .slice(start + '\njobs:\n'.length)
    .split(/\n(?= {2}[A-Za-z_][\w-]*:\n)/)
    .map((chunk) => /^( {2}#.*\n)* {2}([A-Za-z_][\w-]*):\n/m.exec(chunk) ? chunk : '')
    .filter((chunk) => chunk !== '')
    .map((chunk) => {
      const id = /^ {2}([A-Za-z_][\w-]*):$/m.exec(chunk);
      if (!id) throw new Error(`Cannot read a job id from:\n${chunk.slice(0, 80)}`);
      return { id: id[1], body: chunk };
    });
}

function needsOf(job: Job): string[] {
  const needs = /^ {4}needs: \[([^\]]*)\]$/m.exec(job.body);
  return needs ? needs[1].split(',').map((name) => name.trim()).filter(Boolean) : [];
}

/** How many jobs a job expands to: its shard matrix, or one. */
function legsOf(job: Job): number {
  const shards = /^ {8}shardIndex: \[([^\]]*)\]$/m.exec(job.body);
  return shards ? shards[1].split(',').filter((item) => item.trim() !== '').length : 1;
}

/**
 * The jobs a pull request runs at once. A job gated on the event `push` never runs on a PR, and a job
 * that needs anything but that gate waits for its shards, so it holds no slot while they run.
 */
function countPullRequestJobs(ciSource: string): number {
  const jobs = parseJobs(ciSource);
  if (jobs.length === 0) throw new Error('ci.yml yielded no jobs.');
  return jobs
    .filter((job) => !job.body.includes("if: github.event_name == 'push'"))
    .filter((job) => needsOf(job).every((name) => name === 'tested-tree'))
    .reduce((total, job) => total + legsOf(job), 0);
}

/** The literal `paths:` entries of the workflow's pull_request trigger. */
function pullRequestPaths(source: string): string[] {
  const block = /^ {2}pull_request:\n([\s\S]*?)(?=^ {2}\S|^\S)/m.exec(source);
  if (!block) return [];
  return [...block[1].matchAll(/^ {6}- '([^']+)'$/gm)].map((match) => match[1]);
}

/** The macOS jobs this workflow starts on a pull request, net of the legs it excludes there. */
function macosJobsOnPullRequest(source: string): number {
  const inline = [...source.matchAll(/^\s*os: \[([^\]]+)\]$/gm)]
    .flatMap((match) => match[1].split(',').map((runner) => runner.trim()));
  const excluded = [...source.matchAll(/github\.event_name == 'pull_request' && '([^']+)'/g)].map((match) => match[1]);
  const literal = [...source.matchAll(/^\s*runs-on: (macos\S+)$/gm)].map((match) => match[1]);
  return [...inline.filter((runner) => !excluded.includes(runner)), ...literal].filter((runner) => runner.startsWith('macos')).length;
}

/** Whether the workflow runs on a push to a branch. A tag push (`tags:`) is a release, not a re-test. */
function runsOnBranchPush(source: string): boolean {
  const block = /^ {2}push:\n([\s\S]*?)(?=^ {2}\S|^\S)/m.exec(source);
  return block !== null && /^ {4}branches:/m.test(block[1]);
}

function hasTestedTreeGate(source: string): boolean {
  return source.includes('uses: ./.github/actions/tested-tree');
}

function walkSpecs(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return walkSpecs(full);
    return entry.name.endsWith('.spec.ts') ? [full] : [];
  });
}

/** A `retries` set inside a spec, other than on a line gated on Windows. */
function findSpecRetries(source: string): number[] {
  return source.split('\n').flatMap((line, index) =>
    /\bconfigure\(\{[^}]*\bretries\s*:/.test(line) && !line.includes("process.platform === 'win32'") ? [index + 1] : []);
}

function projectBlock(config: string, name: string): string {
  const start = config.indexOf(`name: '${name}',`);
  if (start === -1) throw new Error(`playwright.config.ts has no project named ${name}.`);
  const next = config.indexOf('\n    },\n', start);
  return config.slice(start, next === -1 ? undefined : next);
}

function workersOf(config: string, project: string): string {
  const workers = /^ {6}workers: (.+),$/m.exec(projectBlock(config, project));
  if (!workers) throw new Error(`The ${project} project has no workers line at the indentation this reads.`);
  return workers[1];
}

describe('the concurrency budget', () => {
  const ciSource = readWorkflow('ci.yml');

  it('counts what a pull request runs (proves the collector still matches)', () => {
    const ids = parseJobs(ciSource).map((job) => job.id);
    expect(ids).toEqual(expect.arrayContaining(['checks', 'demo', 'unit-shards', 'playwright-shards', 'e2e-shards', 'tested-tree']));
    expect(countPullRequestJobs(ciSource)).toBeGreaterThan(10);
  });

  it('keeps ci.yml plus the CLA check inside the ceiling', () => {
    const total = countPullRequestJobs(ciSource) + 1;
    expect(
      total,
      `A pull request runs ${total} jobs. GitHub Free allows 20 at once, and the CLA check frees one in seconds. Give a slot up to add one (.claude/rules/test-value.md).`,
    ).toBeLessThanOrEqual(PR_JOB_CEILING);
  });

  it('catches a shard added with nothing given up', () => {
    const regressed = replaceExactly(ciSource, 'shardIndex: [1, 2, 3, 4, 5]\n', 'shardIndex: [1, 2, 3, 4, 5, 6]\n');
    expect(countPullRequestJobs(regressed) + 1).toBeGreaterThan(PR_JOB_CEILING);
  });

  it('counts an always-on job, as the demo job was', () => {
    const before = countPullRequestJobs(ciSource);
    const regressed = replaceExactly(ciSource, '  # Unit tier, sharded across', '  extra:\n    name: Extra\n    runs-on: ubuntu-24.04\n\n  # Unit tier, sharded across');
    expect(countPullRequestJobs(regressed)).toBe(before + 1);
  });

  it('does not count a gate that waits for its shards, or the push-only tree check', () => {
    const jobs = parseJobs(ciSource);
    const gate = jobs.find((job) => job.id === 'ui');
    const treeCheck = jobs.find((job) => job.id === 'tested-tree');
    expect(gate && needsOf(gate)).toContain('playwright-shards');
    expect(treeCheck?.body).toContain("if: github.event_name == 'push'");
  });
});

describe('the macOS budget', () => {
  const lockfileWorkflows = workflowNames().filter((name) => pullRequestPaths(readWorkflow(name)).includes('package-lock.json'));

  it('finds the workflows a lockfile edit starts (proves the collector still matches)', () => {
    expect(lockfileWorkflows).toEqual(expect.arrayContaining(['package-smoke.yml', 'task-reap-real-processes.yml', 'macos-spawn-helper.yml']));
  });

  it('holds a lockfile PR inside the account macOS cap', () => {
    const total = lockfileWorkflows.reduce((sum, name) => sum + macosJobsOnPullRequest(readWorkflow(name)), 0);
    expect(total, 'A lockfile PR starts more macOS jobs than the account can run at once.').toBeLessThanOrEqual(MACOS_JOB_CAP);
  });

  it('reads the legs package-smoke excludes on a pull request', () => {
    expect(macosJobsOnPullRequest(readWorkflow('package-smoke.yml'))).toBe(1);
  });

  it('catches the Intel leg put back on pull requests, past the cap with one more runner', () => {
    const source = readWorkflow('package-smoke.yml');
    const regressed = replaceExactly(source, "          - os: ${{ github.event_name == 'pull_request' && 'macos-26-intel' || 'no-such-leg' }}\n", '');
    expect(macosJobsOnPullRequest(regressed)).toBe(2);
  });
});

describe('push runs on main', () => {
  it('finds the workflows that run on a push to a branch (proves the collector still matches)', () => {
    const onPush = workflowNames().filter((name) => runsOnBranchPush(readWorkflow(name)));
    expect(onPush).toEqual(expect.arrayContaining(['ci.yml', 'codeql.yml', 'task-reap-real-processes.yml']));
    expect(onPush).not.toContain('release.yml');
  });

  it('gates every one of them, or names why not', () => {
    const ungated = workflowNames()
      .filter((name) => runsOnBranchPush(readWorkflow(name)))
      .filter((name) => !hasTestedTreeGate(readWorkflow(name)) && !(name in PUSH_WITHOUT_GATE_ALLOWED));
    expect(
      ungated,
      'A PR-gated workflow re-tests a tree its PR passed unless it carries the tested-tree gate. Add it, or an entry here with the reason.',
    ).toEqual([]);
  });

  it('catches the gate dropped from a real workflow', () => {
    const regressed = replaceExactly(readWorkflow('shell-quoting-posix.yml'), 'uses: ./.github/actions/tested-tree', 'run: echo removed');
    expect(hasTestedTreeGate(regressed)).toBe(false);
    expect(runsOnBranchPush(regressed)).toBe(true);
  });

  it('holds no stale allowlist entry', () => {
    for (const name of Object.keys(PUSH_WITHOUT_GATE_ALLOWED)) {
      const source = readWorkflow(name);
      expect(runsOnBranchPush(source) && !hasTestedTreeGate(source), `${name} no longer needs its entry`).toBe(true);
    }
  });
});

describe('per-spec retries', () => {
  it('sets none, other than on Windows', () => {
    const offenders = ['ui', 'e2e', 'demo'].flatMap((tier) =>
      walkSpecs(path.join(REPO_ROOT, 'tests', tier)).flatMap((file) =>
        findSpecRetries(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')).map((line) => `${path.relative(REPO_ROOT, file)}:${line}`)));
    expect(offenders, '--fail-on-flaky-tests turns a pass on retry into a failure, so a per-spec retry only adds time.').toEqual([]);
  });

  it('flags an unconditional retry and passes the Windows form', () => {
    expect(findSpecRetries('  test.describe.configure({ retries: 2 });\n')).toEqual([1]);
    expect(findSpecRetries("  test.describe.configure({ mode: 'parallel', retries: 1 });\n")).toEqual([1]);
    expect(findSpecRetries("  if (process.platform === 'win32') test.describe.configure({ retries: 2 });\n")).toEqual([]);
    expect(findSpecRetries("  test.describe.configure({ mode: 'parallel' });\n")).toEqual([]);
  });
});

describe('test-builder teaches the real worker counts', () => {
  const config = fs.readFileSync(path.join(REPO_ROOT, 'playwright.config.ts'), 'utf8').replace(/\r\n/g, '\n');
  const agent = fs.readFileSync(path.join(REPO_ROOT, '.claude', 'agents', 'test-builder.md'), 'utf8');

  it('reads the config it compares against', () => {
    expect(workersOf(config, 'ui')).toBe('3');
    expect(workersOf(config, 'electron')).toBe("process.env.CI && process.platform !== 'win32' ? 8 : 1");
    expect(workersOf(config, 'demo')).toBe('process.env.CI ? 3 : 1');
  });

  it('states them', () => {
    expect(agent).toContain('- UI: 3 workers');
    expect(agent).toContain('- E2E: 8 workers on CI, 1 on Windows and locally');
    expect(agent).toContain('- Demo: 3 workers on CI, 1 locally');
    expect(agent, 'A stale count taught every spec written from it the wrong floor.').not.toMatch(/workers=4/);
  });
});
