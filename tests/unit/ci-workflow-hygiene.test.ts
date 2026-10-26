import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Four pins on .github/workflows/*.yml that nothing else watches.
//
// 1. Every Linux runner is pinned to Ubuntu 24.04. The node_modules and Playwright cache keys start
//    with `runner.os`, which reads `Linux` on every Ubuntu release, so a job that drifts to a
//    different release alone restores another release's install tree and never runs `npm ci`
//    there. The runner note at the top of ci.yml owns the reasoning and the unpin plan.
//    release-workflow-gates.test.ts pins two matrices; this test covers every job.
//
// 2. Every literal `paths:` filter entry names a file or directory that exists. A filter entry for
//    a renamed file never matches again, so the workflow stops firing when that file changes and
//    nothing reports it. vitest.config.ts became vitest.config.mts and three workflows carried the
//    old name in both their `pull_request` and `push` filters.
//
// 3. Every Playwright run in ci.yml and deploy-demo.yml passes --fail-on-flaky-tests. CI retries
//    each test once, and without the flag a test that fails and then passes on that retry leaves
//    its check green. The project keeps no flaky tests, and before the flag a flake reached main
//    and was caught only by /release scanning the whole run log. release.yml is out of scope on
//    purpose: its poster captures' retry is how a slow shot lands.
//
// 4. Every workflow whose `npm ci` runs install scripts sets `ONNXRUNTIME_NODE_INSTALL: skip` in its
//    top-level `env:`, and every node_modules cache key in ci.yml is the same string. On Linux x64
//    onnxruntime-node's install script downloads CUDA libraries from nuget.org that nothing loads,
//    and that download timed out the v0.50.0 release's E2E shard before any test ran. Top-level,
//    because a job-level env covers only its own job and a called workflow inherits nothing. The
//    key check holds ci.yml's note that the prefix changes in all six jobs together: a job left on
//    an old key restores a tree installed another way.
//
// The collectors read the YAML with line-anchored regexes, like release-workflow-gates.test.ts,
// because js-yaml is only a transitive dependency. A collector that quietly matches nothing would
// turn each pin into a vacuous pass, so every one fails loudly on a shape it cannot read and the
// real-file tests assert that each form is actually found. Every red case below calls the same
// collector the real-file tests call, including cases that mutate a real workflow in memory.
//
// Tier: Unit.

const REPO_ROOT = path.resolve(__dirname, '../..');
const WORKFLOWS_DIR = path.join(REPO_ROOT, '.github', 'workflows');
const PINNED_LINUX_RUNNERS = ['ubuntu-24.04', 'ubuntu-24.04-arm'];

interface WorkflowFile {
  name: string;
  source: string;
}

function normalizeLineEndings(source: string): string {
  return source.replace(/\r\n/g, '\n');
}

function readWorkflows(): WorkflowFile[] {
  return fs
    .readdirSync(WORKFLOWS_DIR)
    .filter((entryName) => /\.ya?ml$/.test(entryName))
    .sort()
    .map((entryName) => ({
      name: entryName,
      source: normalizeLineEndings(fs.readFileSync(path.join(WORKFLOWS_DIR, entryName), 'utf8')),
    }));
}

function readWorkflowSource(name: string): string {
  const workflow = readWorkflows().find((candidate) => candidate.name === name);
  if (!workflow) throw new Error(`.github/workflows/${name} does not exist`);
  return workflow.source;
}

/**
 * Edit a real workflow's text in memory so a red case runs the collector against the real file's
 * indentation and quoting. Throws when the needle is missing: a stale needle would leave the
 * source unchanged and the red case would pass for nothing.
 */
function replaceExactly(source: string, needle: string, replacement: string): string {
  if (!source.includes(needle)) {
    throw new Error(`The mutation needle ${JSON.stringify(needle)} is not in the source, so this red case would prove nothing.`);
  }
  return source.split(needle).join(replacement);
}

function isBlankOrComment(line: string): boolean {
  return /^\s*(#.*)?$/.test(line);
}

/** Drop a trailing comment and one pair of wrapping quotes from a YAML scalar. */
function cleanScalar(raw: string): string {
  return raw
    .replace(/\s+#.*$/, '')
    .trim()
    .replace(/^(['"])(.*)\1$/, '$2');
}

function parseInlineArray(value: string, where: string): string[] {
  const closeIndex = value.lastIndexOf(']');
  if (!value.startsWith('[') || closeIndex === -1) {
    throw new Error(`${where} opens an inline array that does not close on the same line. Teach the collector that shape.`);
  }
  return value
    .slice(1, closeIndex)
    .split(',')
    .map(cleanScalar)
    .filter((item) => item !== '');
}

// ---------------------------------------------------------------------------------------------
// Pin 1: Linux runner labels
// ---------------------------------------------------------------------------------------------

type RunnerForm = 'runs-on' | 'matrix-leg' | 'matrix-scalar' | 'matrix-inline' | 'matrix-list';

interface RunnerLabel {
  file: string;
  line: number;
  form: RunnerForm;
  label: string;
}

interface MatrixKeyRead {
  file: string;
  line: number;
  key: string;
}

interface RunnerCollection {
  labels: RunnerLabel[];
  matrixKeyReads: MatrixKeyRead[];
}

/** Items of a block list that follows `key:` on a line of its own, deeper than the key. */
function readBlockListItems(lines: string[], keyLineIndex: number, keyIndent: number): { line: number; label: string }[] {
  const items: { line: number; label: string }[] = [];
  for (let nextIndex = keyLineIndex + 1; nextIndex < lines.length; nextIndex++) {
    const nextLine = lines[nextIndex];
    if (isBlankOrComment(nextLine)) continue;
    const item = /^(\s*)-\s+(.*)$/.exec(nextLine);
    if (!item || item[1].length <= keyIndent) break;
    items.push({ line: nextIndex + 1, label: cleanScalar(item[2]) });
  }
  return items;
}

/**
 * Every literal runner label a workflow names, in each place one can sit:
 *  - `runs-on: <label>` (and `runs-on: [<label>, ...]`)
 *  - a matrix list leg, `- os: <label>` (release.yml, package-smoke.yml)
 *  - a matrix inline array, `os: [<label>, ...]` (task-reap-real-processes.yml)
 *  - a matrix block list under `os:`, and a bare `os: <label>` that is not a list leg's first key
 * Values holding `${{ ... }}` are skipped, since `runs-on: ${{ matrix.os }}` is covered by the
 * matrix entries it reads. Those expressions are recorded in `matrixKeyReads` so a matrix key other
 * than `os` cannot slip past this collector.
 */
function collectRunnerLabels(file: string, source: string): RunnerCollection {
  const lines = normalizeLineEndings(source).split('\n');
  const labels: RunnerLabel[] = [];
  const matrixKeyReads: MatrixKeyRead[] = [];
  const addLabel = (line: number, form: RunnerForm, label: string): void => {
    if (label === '' || label.includes('${{')) return;
    labels.push({ file, line, form, label });
  };

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const rawLine = lines[lineIndex];
    if (isBlankOrComment(rawLine)) continue;
    const lineNumber = lineIndex + 1;
    const where = `${file}:${lineNumber}`;

    const runsOnMatch = /^\s*runs-on:\s*(.*)$/.exec(rawLine);
    if (runsOnMatch) {
      const value = cleanScalar(runsOnMatch[1]);
      if (value === '') {
        throw new Error(`${where} writes runs-on as a mapping or block list. Teach collectRunnerLabels that shape, or the Ubuntu pin skips it.`);
      }
      if (value.includes('${{')) {
        for (const keyMatch of value.matchAll(/matrix\.([\w-]+)/g)) {
          matrixKeyReads.push({ file, line: lineNumber, key: keyMatch[1] });
        }
      }
      const items = value.startsWith('[') ? parseInlineArray(value, where) : [value];
      for (const item of items) addLabel(lineNumber, 'runs-on', item);
      continue;
    }

    const osMatch = /^(\s*)(-\s+)?os:\s*(.*)$/.exec(rawLine);
    if (osMatch) {
      const keyIndent = osMatch[1].length;
      const value = cleanScalar(osMatch[3]);
      if (value.startsWith('[')) {
        for (const item of parseInlineArray(value, where)) addLabel(lineNumber, 'matrix-inline', item);
      } else if (value === '') {
        const items = readBlockListItems(lines, lineIndex, keyIndent);
        if (items.length === 0) {
          throw new Error(`${where} has an os: key with no value and no block list under it. Teach collectRunnerLabels that shape.`);
        }
        for (const item of items) addLabel(item.line, 'matrix-list', item.label);
      } else {
        addLabel(lineNumber, osMatch[2] ? 'matrix-leg' : 'matrix-scalar', value);
      }
    }
  }

  return { labels, matrixKeyReads };
}

function findUnpinnedLinuxRunners(file: string, source: string): RunnerLabel[] {
  return collectRunnerLabels(file, source).labels.filter(
    (entry) => /^ubuntu/i.test(entry.label) && !PINNED_LINUX_RUNNERS.includes(entry.label),
  );
}

function formatRunnerViolations(violations: RunnerLabel[]): string {
  const rows = violations.map((entry) => `  ${entry.file}:${entry.line} (${entry.form}) uses "${entry.label}"`);
  return [
    'Linux runners must be exactly ubuntu-24.04 or ubuntu-24.04-arm. Unpinned:',
    ...rows,
    'The cache keys start with runner.os, so every Linux job has to move to a new release together.',
    'See the runner-pin note near the top of .github/workflows/ci.yml for why and how to unpin.',
  ].join('\n');
}

describe('GitHub Actions Linux runner pin', () => {
  it('reads the workflow directory it is meant to guard', () => {
    const names = readWorkflows().map((workflow) => workflow.name);
    expect(names).toEqual(
      expect.arrayContaining(['ci.yml', 'release.yml', 'package-smoke.yml', 'task-reap-real-processes.yml']),
    );
  });

  it('finds every runner form in the real files (proves the collectors still match)', () => {
    const labels = readWorkflows().flatMap((workflow) => collectRunnerLabels(workflow.name, workflow.source).labels);
    expect(labels.filter((entry) => entry.form === 'runs-on').length).toBeGreaterThan(0);

    const expectedFormsByFile: [RunnerForm, string][] = [
      ['runs-on', 'ci.yml'],
      ['matrix-leg', 'release.yml'],
      ['matrix-leg', 'package-smoke.yml'],
      ['matrix-inline', 'task-reap-real-processes.yml'],
    ];
    for (const [form, file] of expectedFormsByFile) {
      expect(
        labels.some((entry) => entry.form === form && entry.file === file),
        `${file} no longer yields a "${form}" label. Either the file changed shape or the collector broke.`,
      ).toBe(true);
    }
  });

  it('pins every Linux runner label in every workflow to Ubuntu 24.04', () => {
    const violations = readWorkflows().flatMap((workflow) => findUnpinnedLinuxRunners(workflow.name, workflow.source));
    expect(violations, formatRunnerViolations(violations)).toEqual([]);
  });

  it('reads only the matrix os key in runs-on, and finds an os entry wherever it does', () => {
    for (const workflow of readWorkflows()) {
      const { labels, matrixKeyReads } = collectRunnerLabels(workflow.name, workflow.source);
      for (const read of matrixKeyReads) {
        expect(
          read.key,
          `${read.file}:${read.line} picks its runner from matrix.${read.key}. The pin check only reads os entries; teach collectRunnerLabels that key.`,
        ).toBe('os');
      }
      if (matrixKeyReads.length > 0) {
        expect(
          labels.some((entry) => entry.form.startsWith('matrix-')),
          `${workflow.name} reads matrix.os in runs-on but the collector found no os entry for it.`,
        ).toBe(true);
      }
    }
  });
});

describe('collectRunnerLabels', () => {
  it('flags ubuntu-latest in a literal runs-on', () => {
    const violations = findUnpinnedLinuxRunners('synthetic.yml', 'jobs:\n  build:\n    runs-on: ubuntu-latest\n');
    expect(violations).toEqual([{ file: 'synthetic.yml', line: 3, form: 'runs-on', label: 'ubuntu-latest' }]);
  });

  it('flags ubuntu-latest in a list leg', () => {
    const source = [
      '    strategy:',
      '      matrix:',
      '        include:',
      '          - os: ubuntu-24.04',
      '          - os: ubuntu-latest',
      '            package: npm run package',
      '    runs-on: ${{ matrix.os }}',
    ].join('\n');
    expect(findUnpinnedLinuxRunners('synthetic.yml', source)).toEqual([
      { file: 'synthetic.yml', line: 5, form: 'matrix-leg', label: 'ubuntu-latest' },
    ]);
  });

  it('flags ubuntu-latest inside an inline os array', () => {
    const source = '      matrix:\n        os: [ubuntu-latest, macos-latest, windows-latest]\n';
    expect(findUnpinnedLinuxRunners('synthetic.yml', source)).toEqual([
      { file: 'synthetic.yml', line: 2, form: 'matrix-inline', label: 'ubuntu-latest' },
    ]);
  });

  it('flags ubuntu-latest in a block list under os and in a bare os scalar', () => {
    const blockList = '      matrix:\n        os:\n          - macos-latest\n          - ubuntu-latest\n';
    expect(findUnpinnedLinuxRunners('synthetic.yml', blockList)).toEqual([
      { file: 'synthetic.yml', line: 4, form: 'matrix-list', label: 'ubuntu-latest' },
    ]);
    const scalar = '          - platform: linux\n            os: ubuntu-latest\n';
    expect(findUnpinnedLinuxRunners('synthetic.yml', scalar)).toEqual([
      { file: 'synthetic.yml', line: 2, form: 'matrix-scalar', label: 'ubuntu-latest' },
    ]);
  });

  it('strips quotes and a trailing comment before it compares', () => {
    const source = "    runs-on: 'ubuntu-latest' # moved by hand\n    other:\n      os: [\"ubuntu-22.04\", 'ubuntu-24.04']\n";
    expect(findUnpinnedLinuxRunners('synthetic.yml', source).map((entry) => entry.label)).toEqual([
      'ubuntu-latest',
      'ubuntu-22.04',
    ]);
  });

  it('accepts the pinned labels and ignores non-Linux ones', () => {
    const source = [
      '    runs-on: ubuntu-24.04',
      '    runs-on: windows-latest',
      '          - os: ubuntu-24.04-arm',
      '          - os: macos-latest',
      '          - os: macos-26-intel',
      '        os: [ubuntu-24.04, macos-latest, macos-26-intel, windows-latest]',
    ].join('\n');
    expect(findUnpinnedLinuxRunners('synthetic.yml', source)).toEqual([]);
  });

  it('skips expressions but records the matrix key they read', () => {
    const collection = collectRunnerLabels('synthetic.yml', '    runs-on: ${{ matrix.os }}\n');
    expect(collection.labels).toEqual([]);
    expect(collection.matrixKeyReads).toEqual([{ file: 'synthetic.yml', line: 1, key: 'os' }]);
  });

  it('ignores comments and text that only mention a runner', () => {
    const source = [
      '# ubuntu-latest moves to Ubuntu 26 on 2026-10-19',
      '    # os: ubuntu-latest',
      '          docker run --rm ubuntu:24.04 sh -c "uname"',
      '    name: build on ubuntu-latest (${{ matrix.os }})',
    ].join('\n');
    expect(collectRunnerLabels('synthetic.yml', source).labels).toEqual([]);
  });

  it('throws on a runs-on or os shape it cannot read, rather than skipping it', () => {
    expect(() => collectRunnerLabels('synthetic.yml', '    runs-on:\n      group: big\n      labels: ubuntu-latest\n')).toThrow(
      /synthetic\.yml:1 writes runs-on as a mapping/,
    );
    expect(() => collectRunnerLabels('synthetic.yml', '        os:\n        - ubuntu-latest\n')).toThrow(
      /synthetic\.yml:1 has an os: key with no value/,
    );
  });

  it('puts the file, the line, the label and a pointer to the ci.yml note in the failure message', () => {
    const message = formatRunnerViolations([{ file: 'deploy.yml', line: 12, form: 'runs-on', label: 'ubuntu-latest' }]);
    expect(message).toContain('deploy.yml:12');
    expect(message).toContain('"ubuntu-latest"');
    expect(message).toContain('.github/workflows/ci.yml');
  });

  it('catches ubuntu-latest put back into a real runs-on (ci.yml)', () => {
    const regressed = replaceExactly(readWorkflowSource('ci.yml'), 'runs-on: ubuntu-24.04', 'runs-on: ubuntu-latest');
    const violations = findUnpinnedLinuxRunners('ci.yml', regressed);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.every((entry) => entry.form === 'runs-on' && entry.label === 'ubuntu-latest')).toBe(true);
  });

  it('catches the arm leg reverted to ubuntu-latest in a real list matrix (release.yml)', () => {
    const regressed = replaceExactly(readWorkflowSource('release.yml'), '- os: ubuntu-24.04-arm', '- os: ubuntu-latest');
    const violations = findUnpinnedLinuxRunners('release.yml', regressed);
    expect(violations.map((entry) => [entry.form, entry.label])).toEqual([['matrix-leg', 'ubuntu-latest']]);
  });

  it('catches ubuntu-latest in the real inline array (task-reap-real-processes.yml)', () => {
    const regressed = replaceExactly(
      readWorkflowSource('task-reap-real-processes.yml'),
      'os: [ubuntu-24.04, macos-latest',
      'os: [ubuntu-latest, macos-latest',
    );
    const violations = findUnpinnedLinuxRunners('task-reap-real-processes.yml', regressed);
    expect(violations.map((entry) => [entry.form, entry.label])).toEqual([['matrix-inline', 'ubuntu-latest']]);
  });
});

// ---------------------------------------------------------------------------------------------
// Pin 2: workflow path filters name files that exist
// ---------------------------------------------------------------------------------------------

interface PathFilterEntry {
  file: string;
  line: number;
  trigger: string;
  entry: string;
}

interface PathFilterCollection {
  entries: PathFilterEntry[];
  blockCount: number;
}

/**
 * Every `paths:` list entry under the workflow's `on:` triggers. The trigger name (`pull_request`,
 * `push`) comes from the key one level above `paths:`. A `paths:` block ends at the first line that
 * is not a deeper `- ` item. Throws on an inline value and on a block that yields nothing, since
 * either would leave the existence check with nothing to read.
 */
function collectPathFilterEntries(file: string, source: string): PathFilterCollection {
  const lines = normalizeLineEndings(source).split('\n');
  const entries: PathFilterEntry[] = [];
  const keyStack: { indent: number; key: string }[] = [];
  let blockCount = 0;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const rawLine = lines[lineIndex];
    if (isBlankOrComment(rawLine)) continue;
    const keyMatch = /^(\s*)['"]?([\w-]+)['"]?:\s*(.*)$/.exec(rawLine);
    if (!keyMatch) continue;

    const indent = keyMatch[1].length;
    while (keyStack.length > 0 && keyStack[keyStack.length - 1].indent >= indent) keyStack.pop();
    keyStack.push({ indent, key: keyMatch[2] });

    if (keyMatch[2] !== 'paths' || keyStack[0].key !== 'on') continue;

    const where = `${file}:${lineIndex + 1}`;
    if (cleanScalar(keyMatch[3]) !== '') {
      throw new Error(`${where} writes paths: with an inline value. Teach collectPathFilterEntries that shape.`);
    }
    const trigger = keyStack.length >= 3 ? keyStack[keyStack.length - 2].key : '';
    const blockEntries: PathFilterEntry[] = [];
    for (let nextIndex = lineIndex + 1; nextIndex < lines.length; nextIndex++) {
      const nextLine = lines[nextIndex];
      if (isBlankOrComment(nextLine)) continue;
      const item = /^(\s*)-\s+(.*)$/.exec(nextLine);
      if (!item || item[1].length <= indent) break;
      blockEntries.push({ file, line: nextIndex + 1, trigger, entry: cleanScalar(item[2]) });
    }
    if (blockEntries.length === 0) {
      throw new Error(`${where} has a paths: block that yielded no entries. Teach collectPathFilterEntries that shape.`);
    }
    entries.push(...blockEntries);
    blockCount++;
  }

  return { entries, blockCount };
}

/** A GitHub path-filter pattern is a plain path unless it carries a glob character or negates. */
function isLiteralPath(entry: string): boolean {
  return !/[*?[{]/.test(entry) && !entry.startsWith('!');
}

function findMissingPathFilterEntries(
  file: string,
  source: string,
  pathExists: (entry: string) => boolean,
): PathFilterEntry[] {
  return collectPathFilterEntries(file, source).entries.filter((candidate) => isLiteralPath(candidate.entry) && !pathExists(candidate.entry));
}

function repoPathExists(entry: string): boolean {
  return fs.existsSync(path.join(REPO_ROOT, entry));
}

function formatMissingEntries(missing: PathFilterEntry[]): string {
  const rows = missing.map((candidate) => `  ${candidate.file}:${candidate.line} (${candidate.trigger}) names "${candidate.entry}"`);
  return [
    'A paths: filter entry names a file or directory that does not exist under the repo root. Unmatched:',
    ...rows,
    'A filter entry for a renamed or deleted file never matches, so the workflow stops running when that file changes.',
  ].join('\n');
}

describe('GitHub Actions paths: filters', () => {
  it('extracts the filter entries it is meant to check (proves the collector still matches)', () => {
    const workflows = readWorkflows();
    const collections = workflows.map((workflow) => ({
      name: workflow.name,
      source: workflow.source,
      collection: collectPathFilterEntries(workflow.name, workflow.source),
    }));
    expect(collections.reduce((total, current) => total + current.collection.entries.length, 0)).toBeGreaterThan(0);

    // A loose count of paths: lines against the strict count of blocks the collector read: a
    // spelling the strict regex stops matching would drop a whole block without any error.
    for (const { name, source, collection } of collections) {
      const looseBlockCount = source.split('\n').filter((line) => /^\s*paths:/.test(line)).length;
      expect(collection.blockCount, `${name} has ${looseBlockCount} paths: key(s) but the collector read ${collection.blockCount}`).toBe(looseBlockCount);
    }

    const taskReap = collections.find((current) => current.name === 'task-reap-real-processes.yml');
    const taskReapTriggers = new Set(taskReap?.collection.entries.map((entry) => entry.trigger));
    expect([...taskReapTriggers].sort()).toEqual(['pull_request', 'push']);
  });

  it('only names files and directories that exist', () => {
    const missing = readWorkflows().flatMap((workflow) => findMissingPathFilterEntries(workflow.name, workflow.source, repoPathExists));
    expect(missing, formatMissingEntries(missing)).toEqual([]);
  });

  it('the renamed config is gone under its old name and present under the new one', () => {
    // The red cases below lean on this: they put the old name back and expect a miss.
    expect(
      repoPathExists('vitest.config.ts'),
      'vitest.config.ts exists again, so the red cases below no longer prove a dead entry is caught. Pick another renamed file for them.',
    ).toBe(false);
    expect(repoPathExists('vitest.config.mts')).toBe(true);
  });
});

describe('collectPathFilterEntries', () => {
  const syntheticSource = [
    'name: Synthetic',
    'on:',
    '  pull_request:',
    '    branches: [main]',
    '    paths:',
    "      - 'present.ts'",
    "      - 'missing.ts'",
    '      # a comment between entries',
    "      - 'src/**'",
    "      - '!docs/ignored.md'",
    '  push:',
    '    paths:',
    '      - missing-on-push.ts # trailing comment',
    'jobs:',
    '  job:',
    '    steps:',
    '      - uses: some/action@v1',
    '        with:',
    '          paths:',
    '            - not-a-trigger-filter.ts',
    '',
  ].join('\n');
  const pathExists = (entry: string): boolean => entry === 'present.ts';

  it('reports a literal entry that names a missing file, with its line and trigger', () => {
    expect(findMissingPathFilterEntries('synthetic.yml', syntheticSource, pathExists)).toEqual([
      { file: 'synthetic.yml', line: 7, trigger: 'pull_request', entry: 'missing.ts' },
      { file: 'synthetic.yml', line: 13, trigger: 'push', entry: 'missing-on-push.ts' },
    ]);
  });

  it('skips globs and negations, and ignores a paths: key outside on:', () => {
    const entries = collectPathFilterEntries('synthetic.yml', syntheticSource).entries.map((candidate) => candidate.entry);
    expect(entries).toEqual(['present.ts', 'missing.ts', 'src/**', '!docs/ignored.md', 'missing-on-push.ts']);
    expect(['src/**', '!docs/ignored.md', 'a?b.ts', 'a[1].ts', 'a{b,c}.ts'].some(isLiteralPath)).toBe(false);
    expect(['package.json', 'build/', '.github/workflows/ci.yml'].every(isLiteralPath)).toBe(true);
  });

  it('throws on a paths: shape it cannot read, rather than checking nothing', () => {
    expect(() => collectPathFilterEntries('synthetic.yml', 'on:\n  push:\n    paths: [a.ts, b.ts]\n')).toThrow(
      /synthetic\.yml:3 writes paths: with an inline value/,
    );
    expect(() => collectPathFilterEntries('synthetic.yml', 'on:\n  push:\n    paths:\n    - a.ts\n')).toThrow(
      /synthetic\.yml:3 has a paths: block that yielded no entries/,
    );
  });

  it.each(['shell-quoting-posix.yml', 'shell-quoting-windows.yml', 'task-reap-real-processes.yml'])(
    'catches the dead vitest.config.ts name put back into the real %s filters',
    (workflowName) => {
      const regressed = replaceExactly(readWorkflowSource(workflowName), "'vitest.config.mts'", "'vitest.config.ts'");
      const missing = findMissingPathFilterEntries(workflowName, regressed, repoPathExists);
      expect(missing.map((candidate) => [candidate.trigger, candidate.entry])).toEqual([
        ['pull_request', 'vitest.config.ts'],
        ['push', 'vitest.config.ts'],
      ]);
    },
  );
});

// ---------------------------------------------------------------------------------------------
// Pin 3: every Playwright run in ci.yml fails on a flaky test
// ---------------------------------------------------------------------------------------------

const FAIL_ON_FLAKY_FLAG = '--fail-on-flaky-tests';

interface PlaywrightRun {
  line: number;
  command: string;
  /** The package.json script it goes through, or null for a direct `playwright test`. */
  viaScript: string | null;
}

/** The package.json scripts whose command runs `playwright test`, so `npm run <name>` counts as a Playwright run. */
function readPlaywrightScripts(): string[] {
  const packageJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
  return Object.entries(packageJson.scripts)
    .filter(([, command]) => /\bplaywright test\b/.test(command))
    .map(([name]) => name);
}

/**
 * Every line of a workflow that runs Playwright: a direct `playwright test`, or `npm run` of a
 * script that runs it. Comment lines are skipped. Every other line is read, block-scalar `run: |`
 * bodies included, so a command moved into a multi-line step is still found.
 */
function collectPlaywrightRuns(source: string, playwrightScripts: string[]): PlaywrightRun[] {
  const runs: PlaywrightRun[] = [];
  normalizeLineEndings(source).split('\n').forEach((rawLine, lineIndex) => {
    if (isBlankOrComment(rawLine)) return;
    const command = rawLine.replace(/^\s*(-\s+)?(run:\s*)?/, '').trim();
    if (/\bplaywright test\b/.test(command)) {
      runs.push({ line: lineIndex + 1, command, viaScript: null });
      return;
    }
    const scriptMatch = /\bnpm run ([\w:-]+)/.exec(command);
    if (scriptMatch && playwrightScripts.includes(scriptMatch[1])) {
      runs.push({ line: lineIndex + 1, command, viaScript: scriptMatch[1] });
    }
  });
  return runs;
}

/**
 * A run without the flag, or an `npm run` that passes it before npm's `--` separator, where npm
 * takes it as its own option and Playwright never sees it.
 */
function findRunsThatLetFlakesPass(runs: PlaywrightRun[]): PlaywrightRun[] {
  return runs.filter((run) => {
    const tokens = run.command.split(/\s+/);
    const flagIndex = tokens.indexOf(FAIL_ON_FLAKY_FLAG);
    if (flagIndex === -1) return true;
    if (run.viaScript === null) return false;
    const separatorIndex = tokens.indexOf('--');
    return separatorIndex === -1 || separatorIndex > flagIndex;
  });
}

function formatFlakeViolations(workflowName: string, violations: PlaywrightRun[]): string {
  const rows = violations.map((run) => `  ${workflowName}:${run.line} runs "${run.command}"`);
  return [
    `Every Playwright run in ${workflowName} must pass ${FAIL_ON_FLAKY_FLAG} (through npm's -- separator for an npm run). Missing:`,
    ...rows,
    'CI retries each test once, so without the flag a test that passes only on its retry leaves the check green.',
    'See the note above the UI shards run step in .github/workflows/ci.yml.',
  ].join('\n');
}

describe('ci.yml Playwright runs fail on a flaky test', () => {
  const playwrightScripts = readPlaywrightScripts();
  const ciSource = readWorkflowSource('ci.yml');

  it('knows test:demo as a Playwright script (proves the script reader still matches)', () => {
    expect(playwrightScripts).toContain('test:demo');
  });

  it('finds exactly the UI, E2E and web demo runs', () => {
    const runs = collectPlaywrightRuns(ciSource, playwrightScripts);
    const signatures = runs.map((run) => {
      if (run.command.includes('--project=ui')) return 'ui';
      if (run.command.includes('--project=electron')) return 'electron';
      if (run.viaScript === 'test:demo') return 'demo';
      return run.command;
    });
    expect(
      signatures.sort(),
      'ci.yml no longer runs exactly these three Playwright commands. Update this list with the new shape, and keep the flag on it.',
    ).toEqual(['demo', 'electron', 'ui']);
  });

  it('passes --fail-on-flaky-tests on every one of them', () => {
    const violations = findRunsThatLetFlakesPass(collectPlaywrightRuns(ciSource, playwrightScripts));
    expect(violations, formatFlakeViolations('ci.yml', violations)).toEqual([]);
  });

  it('catches the flag dropped from the real UI shard run', () => {
    const regressed = replaceExactly(
      ciSource,
      `--project=ui --shard=\${{ matrix.shardIndex }}/\${{ matrix.shardTotal }} ${FAIL_ON_FLAKY_FLAG}`,
      `--project=ui --shard=\${{ matrix.shardIndex }}/\${{ matrix.shardTotal }}`,
    );
    const violations = findRunsThatLetFlakesPass(collectPlaywrightRuns(regressed, playwrightScripts));
    expect(violations.map((run) => run.command.includes('--project=ui'))).toEqual([true]);
  });

  it('catches the flag dropped from the real web demo run', () => {
    const regressed = replaceExactly(ciSource, `npm run test:demo -- ${FAIL_ON_FLAKY_FLAG}`, 'npm run test:demo');
    const violations = findRunsThatLetFlakesPass(collectPlaywrightRuns(regressed, playwrightScripts));
    expect(violations.map((run) => run.viaScript)).toEqual(['test:demo']);
  });

  it('flags an npm run that passes the flag where npm keeps it', () => {
    const runs = collectPlaywrightRuns(`        run: npm run test:demo ${FAIL_ON_FLAKY_FLAG}\n`, playwrightScripts);
    expect(findRunsThatLetFlakesPass(runs)).toHaveLength(1);
  });

  it('flags an npm run that has a separator but puts the flag before it', () => {
    // The `--` exists, so this is not the no-separator case above. npm still keeps a flag that sits
    // to its left, so only a separator that comes first lets Playwright see the flag.
    const runs = collectPlaywrightRuns(`        run: npm run test:demo ${FAIL_ON_FLAKY_FLAG} -- --reporter=line\n`, playwrightScripts);
    expect(findRunsThatLetFlakesPass(runs)).toHaveLength(1);
  });

  it('accepts an npm run that puts the flag after the separator among other arguments', () => {
    const runs = collectPlaywrightRuns(`        run: npm run test:demo -- --reporter=line ${FAIL_ON_FLAKY_FLAG}\n`, playwrightScripts);
    expect(runs).toHaveLength(1);
    expect(findRunsThatLetFlakesPass(runs)).toEqual([]);
  });

  it('reads a Playwright command inside a block-scalar run and skips comments', () => {
    const source = [
      '        run: |',
      '          echo starting',
      '          npx playwright test --project=ui',
      '        # npx playwright test --project=electron is only mentioned here',
    ].join('\n');
    const runs = collectPlaywrightRuns(source, playwrightScripts);
    expect(runs).toEqual([{ line: 3, command: 'npx playwright test --project=ui', viaScript: null }]);
    expect(findRunsThatLetFlakesPass(runs)).toHaveLength(1);
  });
});

describe('deploy-demo.yml Playwright runs fail on a flaky test', () => {
  const playwrightScripts = readPlaywrightScripts();
  const deploySource = readWorkflowSource('deploy-demo.yml');

  it('finds exactly the web demo smoke', () => {
    const runs = collectPlaywrightRuns(deploySource, playwrightScripts);
    expect(
      runs.map((run) => run.viaScript),
      'deploy-demo.yml no longer runs exactly the test:demo smoke. Update this list with the new shape, and keep the flag on it.',
    ).toEqual(['test:demo']);
  });

  it('passes --fail-on-flaky-tests on it', () => {
    const violations = findRunsThatLetFlakesPass(collectPlaywrightRuns(deploySource, playwrightScripts));
    expect(violations, formatFlakeViolations('deploy-demo.yml', violations)).toEqual([]);
  });

  it('catches the flag dropped from the real smoke run', () => {
    const regressed = replaceExactly(deploySource, `npm run test:demo -- ${FAIL_ON_FLAKY_FLAG}`, 'npm run test:demo');
    const violations = findRunsThatLetFlakesPass(collectPlaywrightRuns(regressed, playwrightScripts));
    expect(violations.map((run) => run.viaScript)).toEqual(['test:demo']);
  });
});

// ---------------------------------------------------------------------------------------------
// Pin 4: onnxruntime-node's CUDA download is skipped, and ci.yml's node_modules keys agree
// ---------------------------------------------------------------------------------------------

const ONNXRUNTIME_INSTALL_VARIABLE = 'ONNXRUNTIME_NODE_INSTALL';

interface NpmCiRun {
  line: number;
  command: string;
}

/**
 * Every line of a workflow that runs `npm ci`, as a `run:` value or a line of a block-scalar body.
 * A step `name:` that only mentions npm ci is not a run, and comment lines are skipped.
 */
function collectNpmCiRuns(source: string): NpmCiRun[] {
  const runs: NpmCiRun[] = [];
  normalizeLineEndings(source).split('\n').forEach((rawLine, lineIndex) => {
    if (isBlankOrComment(rawLine)) return;
    const command = rawLine.replace(/^\s*(-\s+)?(run:\s*)?/, '').trim();
    if (/^npm ci\b/.test(command)) runs.push({ line: lineIndex + 1, command });
  });
  return runs;
}

/** The runs whose install scripts execute, which is where onnxruntime-node's download happens. */
function collectScriptedNpmCiRuns(source: string): NpmCiRun[] {
  return collectNpmCiRuns(source).filter((run) => !run.command.split(/\s+/).includes('--ignore-scripts'));
}

/**
 * The variables of the workflow's top-level `env:` block, or null when it has none. Throws on an
 * inline mapping, which the line reader below cannot see into.
 */
function readTopLevelEnv(file: string, source: string): Map<string, string> | null {
  const lines = normalizeLineEndings(source).split('\n');
  const envLineIndex = lines.findIndex((line) => /^env:/.test(line));
  if (envLineIndex === -1) return null;
  if (cleanScalar(lines[envLineIndex].slice('env:'.length)) !== '') {
    throw new Error(`${file}:${envLineIndex + 1} writes the top-level env: inline. Teach readTopLevelEnv that shape.`);
  }
  const variables = new Map<string, string>();
  for (let nextIndex = envLineIndex + 1; nextIndex < lines.length; nextIndex++) {
    const nextLine = lines[nextIndex];
    if (isBlankOrComment(nextLine)) continue;
    if (!/^\s/.test(nextLine)) break;
    const variable = /^\s+([A-Za-z_][\w]*):\s*(.*)$/.exec(nextLine);
    if (!variable) {
      throw new Error(`${file}:${nextIndex + 1} is inside the top-level env: but is not a NAME: value line. Teach readTopLevelEnv that shape.`);
    }
    variables.set(variable[1], cleanScalar(variable[2]));
  }
  return variables;
}

interface MissingSkip {
  file: string;
  npmCiLines: number[];
  found: string | null;
}

function findWorkflowsMissingOnnxruntimeSkip(workflows: WorkflowFile[]): MissingSkip[] {
  return workflows.flatMap((workflow) => {
    const runs = collectScriptedNpmCiRuns(workflow.source);
    if (runs.length === 0) return [];
    const found = readTopLevelEnv(workflow.name, workflow.source)?.get(ONNXRUNTIME_INSTALL_VARIABLE) ?? null;
    return found === 'skip' ? [] : [{ file: workflow.name, npmCiLines: runs.map((run) => run.line), found }];
  });
}

function formatMissingSkips(missing: MissingSkip[]): string {
  const rows = missing.map((entry) => `  ${entry.file} (npm ci on line ${entry.npmCiLines.join(', ')}) has ${entry.found === null ? 'no top-level setting' : `"${entry.found}"`}`);
  return [
    `Every workflow whose npm ci runs install scripts must set ${ONNXRUNTIME_INSTALL_VARIABLE}: skip in its top-level env:. Missing:`,
    ...rows,
    'Without it onnxruntime-node downloads CUDA libraries from nuget.org on Linux x64 that the app never loads.',
    'See the note above the env: block at the top of .github/workflows/ci.yml.',
  ].join('\n');
}

interface CacheKey {
  line: number;
  key: string;
}

/** Every cache `key:` that names node_modules. */
function collectNodeModulesCacheKeys(source: string): CacheKey[] {
  const keys: CacheKey[] = [];
  normalizeLineEndings(source).split('\n').forEach((rawLine, lineIndex) => {
    if (isBlankOrComment(rawLine)) return;
    const keyMatch = /^\s*key:\s*(.*)$/.exec(rawLine);
    if (keyMatch && keyMatch[1].includes('node-modules')) keys.push({ line: lineIndex + 1, key: cleanScalar(keyMatch[1]) });
  });
  return keys;
}

describe('onnxruntime-node CUDA download is skipped in every workflow that runs install scripts', () => {
  it('finds the scripted npm ci runs it is meant to guard, and exempts --ignore-scripts', () => {
    const workflows = readWorkflows();
    const scripted = workflows.filter((workflow) => collectScriptedNpmCiRuns(workflow.source).length > 0).map((workflow) => workflow.name);
    expect(scripted).toEqual(expect.arrayContaining(['ci.yml', 'release.yml', 'package-smoke.yml', 'deploy-demo.yml']));
    expect(collectScriptedNpmCiRuns(readWorkflowSource('ci.yml')).length, 'ci.yml has one npm ci per job that caches node_modules').toBeGreaterThanOrEqual(6);
    for (const exempt of ['task-reap-real-processes.yml', 'macos-spawn-helper.yml']) {
      const source = readWorkflowSource(exempt);
      expect(collectNpmCiRuns(source).length, `${exempt} no longer runs npm ci, so it no longer proves the exemption`).toBeGreaterThan(0);
      expect(collectScriptedNpmCiRuns(source)).toEqual([]);
    }
  });

  it('every one of them sets the skip in its top-level env', () => {
    const missing = findWorkflowsMissingOnnxruntimeSkip(readWorkflows());
    expect(missing, formatMissingSkips(missing)).toEqual([]);
  });

  it.each(['ci.yml', 'release.yml'])('catches the skip dropped from the real %s', (workflowName) => {
    const regressed = replaceExactly(readWorkflowSource(workflowName), `  ${ONNXRUNTIME_INSTALL_VARIABLE}: skip\n`, '');
    const missing = findWorkflowsMissingOnnxruntimeSkip([{ name: workflowName, source: regressed }]);
    expect(missing.map((entry) => [entry.file, entry.found])).toEqual([[workflowName, null]]);
  });

  it('flags a skip set only on a job, and a value other than skip', () => {
    const jobLevelOnly = [
      'jobs:',
      '  build:',
      '    env:',
      `      ${ONNXRUNTIME_INSTALL_VARIABLE}: skip`,
      '    steps:',
      '      - name: Install dependencies (npm ci)',
      '        run: npm ci',
    ].join('\n');
    expect(findWorkflowsMissingOnnxruntimeSkip([{ name: 'job-level.yml', source: jobLevelOnly }])).toEqual([
      { file: 'job-level.yml', npmCiLines: [7], found: null },
    ]);
    const otherValue = `env:\n  ${ONNXRUNTIME_INSTALL_VARIABLE}: cuda12\njobs:\n  build:\n    steps:\n      - run: npm ci\n`;
    expect(findWorkflowsMissingOnnxruntimeSkip([{ name: 'other-value.yml', source: otherValue }])).toEqual([
      { file: 'other-value.yml', npmCiLines: [6], found: 'cuda12' },
    ]);
  });

  it('reads npm ci in a block-scalar run, and ignores step names and comments that mention it', () => {
    const source = [
      '      - name: Install dependencies (npm ci, with the Electron binary)',
      '        run: |',
      '          echo installing',
      '          npm ci',
      '      # npm ci is only mentioned here',
      '      - run: npm ci --ignore-scripts',
    ].join('\n');
    expect(collectNpmCiRuns(source).map((run) => run.line)).toEqual([4, 6]);
    expect(collectScriptedNpmCiRuns(source).map((run) => run.line)).toEqual([4]);
  });

  it('throws on a top-level env shape it cannot read, rather than reading nothing', () => {
    expect(() => readTopLevelEnv('synthetic.yml', `env: { ${ONNXRUNTIME_INSTALL_VARIABLE}: skip }\n`)).toThrow(
      /synthetic\.yml:1 writes the top-level env: inline/,
    );
    expect(() => readTopLevelEnv('synthetic.yml', 'env:\n  - not a mapping\njobs:\n')).toThrow(
      /synthetic\.yml:2 is inside the top-level env:/,
    );
  });
});

describe('ci.yml node_modules cache keys agree', () => {
  const ciSource = readWorkflowSource('ci.yml');

  it('finds one node_modules key per cached node_modules path (proves the collector still matches)', () => {
    const cachedPaths = ciSource.split('\n').filter((line) => /^\s*path:\s*node_modules\s*$/.test(line)).length;
    expect(cachedPaths).toBeGreaterThanOrEqual(6);
    expect(collectNodeModulesCacheKeys(ciSource)).toHaveLength(cachedPaths);
  });

  it('uses the same key in every job', () => {
    const distinct = [...new Set(collectNodeModulesCacheKeys(ciSource).map((entry) => entry.key))];
    expect(
      distinct,
      'ci.yml caches node_modules under more than one key. Change the prefix in every job together (see the note at the top of ci.yml).',
    ).toHaveLength(1);
  });

  it('catches one job left on an old prefix', () => {
    // Changes only the first key line, found by the collector, so this case outlives the next
    // prefix change instead of carrying a copy of ci.yml's step.
    const lines = ciSource.split('\n');
    const [firstKey] = collectNodeModulesCacheKeys(ciSource);
    lines[firstKey.line - 1] = lines[firstKey.line - 1].replace('node-modules-', 'stale-node-modules-');
    const regressed = lines.join('\n');
    expect(regressed).not.toBe(ciSource);
    expect(new Set(collectNodeModulesCacheKeys(regressed).map((entry) => entry.key)).size).toBe(2);
  });
});
