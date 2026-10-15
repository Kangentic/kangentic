import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Two pins on .github/workflows/*.yml that nothing else watches.
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
