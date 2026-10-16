import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Pins the second TypeScript program that type-checks the demo tier.
//
// The root tsconfig.json covers none of tests/demo, tests/captures or demo/*.ts, so those files
// are checked by a program of their own (tsconfig.demo.json). Three pieces make that program run,
// and nothing else watches any of them: revert one and every test stays green while a type error
// in the demo tier ships.
//
//   1. tsconfig.demo.json extends the root config and includes the three demo-tier trees.
//   2. package.json scripts: `typecheck` chains `typecheck:src` (the root program) and
//      `typecheck:demo` (`-p tsconfig.demo.json`).
//   3. .github/workflows/ci.yml, `checks` job: `typecheck` runs `npm run typecheck:src`, a step
//      with id `typecheck_demo` runs `npm run typecheck:demo`, and the summary step reports both
//      outcomes. The summary is what turns a red step into a red job, so a step it never reads
//      cannot fail CI.
//
// ci.yml is read with a line scan, like ci-workflow-hygiene.test.ts and ci-required-checks.test.ts,
// because no YAML parser is a direct dependency. Values are compared EXACTLY: `npm run typecheck`
// is a substring of `npm run typecheck:demo`, and the id `typecheck` is a prefix of
// `typecheck_demo`, so a substring or prefix match would pass for the wrong step. A scan that
// stops matching would pass against nothing, so the real-file tests assert the job and its known
// steps are found, and every red case below edits the REAL text in memory and calls the same
// function the real-file test calls.
//
// Tier: Unit.

const REPO_ROOT = path.resolve(__dirname, '../..');

interface TypecheckWiringSources {
  tsconfigDemo: string;
  packageJson: string;
  ciYml: string;
}

function normalizeLineEndings(source: string): string {
  return source.replace(/\r\n/g, '\n');
}

function readRepoFile(relativePath: string): string {
  return normalizeLineEndings(fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8'));
}

function readSources(): TypecheckWiringSources {
  return {
    tsconfigDemo: readRepoFile('tsconfig.demo.json'),
    packageJson: readRepoFile('package.json'),
    ciYml: readRepoFile('.github/workflows/ci.yml'),
  };
}

/**
 * Edit real text in memory so a red case runs the checker against the real file's indentation and
 * quoting. Throws when the needle is missing: a stale needle would leave the source unchanged and
 * the red case would pass for nothing.
 */
function replaceExactly(source: string, needle: string, replacement: string): string {
  if (!source.includes(needle)) {
    throw new Error(`The mutation needle ${JSON.stringify(needle)} is not in the source, so this red case would prove nothing.`);
  }
  return source.split(needle).join(replacement);
}

/** Drop a trailing comment and one pair of wrapping quotes from a YAML scalar. */
function cleanScalar(raw: string): string {
  return raw
    .replace(/\s+#.*$/, '')
    .trim()
    .replace(/^(['"])(.*)\1$/, '$2');
}

// ---------------------------------------------------------------------------------------------
// ci.yml: the `checks` job
// ---------------------------------------------------------------------------------------------

/** The lines of one job under the top-level `jobs:` key, or null when the job is not there. */
function readJobLines(ciYml: string, jobId: string): string[] | null {
  const lines = normalizeLineEndings(ciYml).split('\n');
  const jobsIndex = lines.findIndex((line) => /^jobs:\s*$/.test(line));
  if (jobsIndex === -1) return null;
  const startIndex = lines.findIndex((line, lineIndex) => lineIndex > jobsIndex && line === `  ${jobId}:`);
  if (startIndex === -1) return null;
  let endIndex = lines.length;
  for (let lineIndex = startIndex + 1; lineIndex < lines.length; lineIndex++) {
    // The next job id, or any other zero-indent key. A zero-indent comment does not end the job.
    if (/^ {2}[A-Za-z_][\w-]*:\s*$/.test(lines[lineIndex]) || /^[^\s#]/.test(lines[lineIndex])) {
      endIndex = lineIndex;
      break;
    }
  }
  return lines.slice(startIndex, endIndex);
}

interface WorkflowStep {
  id: string | null;
  condition: string | null;
  run: string | null;
}

/** A step field at step indentation, so a `with:` entry or a `run: |` body line never matches. */
function readStepField(stepLines: string[], key: string): string | null {
  const fieldPattern = new RegExp(`^ {8}${key}:\\s*(.*)$`);
  for (const line of stepLines) {
    const match = fieldPattern.exec(line);
    if (match) return cleanScalar(match[1]);
  }
  return null;
}

function readSteps(jobLines: string[]): WorkflowStep[] {
  const stepsIndex = jobLines.findIndex((line) => /^ {4}steps:\s*$/.test(line));
  if (stepsIndex === -1) return [];
  const stepGroups: string[][] = [];
  for (const line of jobLines.slice(stepsIndex + 1)) {
    if (/^ {6}- /.test(line)) {
      // Re-indent the dash line so its first key reads like every other key of the step.
      stepGroups.push([line.replace(/^ {6}- /, '        ')]);
    } else if (stepGroups.length > 0) {
      stepGroups[stepGroups.length - 1].push(line);
    }
  }
  return stepGroups.map((stepLines) => ({
    id: readStepField(stepLines, 'id'),
    condition: readStepField(stepLines, 'if'),
    run: readStepField(stepLines, 'run'),
  }));
}

/** Whether the job's summary script has a `check "<label>" "${{ steps.<id>.outcome }}"` line. */
function summaryReportsOutcome(jobLines: string[], stepId: string): boolean {
  const summaryPattern = new RegExp(`^\\s*check\\s+"[^"]+"\\s+"\\$\\{\\{\\s*steps\\.${stepId}\\.outcome\\s*\\}\\}"\\s*$`);
  return jobLines.some((line) => summaryPattern.test(line));
}

// ---------------------------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------------------------

function parseJsonObject(source: string, label: string, problems: string[]): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(source);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Reported below with the rest.
  }
  problems.push(`${label} is not a JSON object.`);
  return null;
}

function includeCovers(includeEntries: string[], directory: string): boolean {
  return includeEntries.some((entry) => entry === directory || entry.startsWith(`${directory}/`));
}

function readScript(scripts: Record<string, unknown> | null, name: string): string | null {
  const value = scripts?.[name];
  return typeof value === 'string' ? value : null;
}

const NAMES_DEMO_PROGRAM = /(?:^|\s)(?:-p|--project)\s+(?:\.\/)?tsconfig\.demo\.json(?:\s|$)/;
const NAMES_ANY_PROJECT = /(?:^|\s)(?:-p|--project)(?:\s|=|$)/;

/** Every way the demo-tier typecheck wiring is broken. An empty list means it is whole. */
function findTypecheckWiringProblems(sources: TypecheckWiringSources): string[] {
  const problems: string[] = [];

  // 1. tsconfig.demo.json
  const tsconfigDemo = parseJsonObject(sources.tsconfigDemo, 'tsconfig.demo.json', problems);
  if (tsconfigDemo) {
    if (tsconfigDemo.extends !== './tsconfig.json') {
      problems.push(`tsconfig.demo.json must extend "./tsconfig.json" (strict mode and paths come from there), but extends ${JSON.stringify(tsconfigDemo.extends)}.`);
    }
    const includeEntries = Array.isArray(tsconfigDemo.include)
      ? tsconfigDemo.include.filter((entry): entry is string => typeof entry === 'string')
      : [];
    for (const directory of ['tests/demo', 'tests/captures', 'demo']) {
      if (!includeCovers(includeEntries, directory)) {
        problems.push(`tsconfig.demo.json include does not cover ${directory}, so its type errors would ship (include: ${JSON.stringify(includeEntries)}).`);
      }
    }
  }

  // 2. package.json scripts
  const packageJson = parseJsonObject(sources.packageJson, 'package.json', problems);
  const scripts = packageJson && typeof packageJson.scripts === 'object' && packageJson.scripts !== null
    ? (packageJson.scripts as Record<string, unknown>)
    : null;
  const typecheckScript = readScript(scripts, 'typecheck');
  const typecheckSourceScript = readScript(scripts, 'typecheck:src');
  const typecheckDemoScript = readScript(scripts, 'typecheck:demo');

  const chainedCommands = (typecheckScript ?? '').split('&&').map((command) => command.trim());
  for (const requiredCommand of ['npm run typecheck:src', 'npm run typecheck:demo']) {
    if (!chainedCommands.includes(requiredCommand)) {
      problems.push(`package.json "typecheck" must run "${requiredCommand}" (found ${JSON.stringify(typecheckScript)}).`);
    }
  }
  if (typecheckSourceScript === null || !/^tsc\b/.test(typecheckSourceScript) || NAMES_ANY_PROJECT.test(typecheckSourceScript)) {
    problems.push(`package.json "typecheck:src" must be the root program: tsc with no -p or --project (found ${JSON.stringify(typecheckSourceScript)}).`);
  }
  if (typecheckDemoScript === null || !/^tsc\b/.test(typecheckDemoScript) || !NAMES_DEMO_PROGRAM.test(typecheckDemoScript)) {
    problems.push(`package.json "typecheck:demo" must be tsc with "-p tsconfig.demo.json" (found ${JSON.stringify(typecheckDemoScript)}).`);
  }

  // 3. ci.yml, `checks` job
  const jobLines = readJobLines(sources.ciYml, 'checks');
  if (!jobLines) {
    problems.push('ci.yml has no `checks` job under `jobs:`.');
    return problems;
  }
  const steps = readSteps(jobLines);
  const sourceStep = steps.find((step) => step.id === 'typecheck');
  const demoStep = steps.find((step) => step.id === 'typecheck_demo');

  if (!sourceStep) {
    problems.push('ci.yml `checks` job has no step with id `typecheck`.');
  } else if (sourceStep.run !== 'npm run typecheck:src') {
    problems.push(`ci.yml step \`typecheck\` must run exactly "npm run typecheck:src", or the root program runs twice and a later edit can drop one (found ${JSON.stringify(sourceStep.run)}).`);
  }
  if (!demoStep) {
    problems.push('ci.yml `checks` job has no step with id `typecheck_demo`, so CI never type-checks the demo tier.');
  } else {
    if (demoStep.run !== 'npm run typecheck:demo') {
      problems.push(`ci.yml step \`typecheck_demo\` must run exactly "npm run typecheck:demo" (found ${JSON.stringify(demoStep.run)}).`);
    }
    if (demoStep.condition === null || !demoStep.condition.includes('!cancelled()')) {
      problems.push(`ci.yml step \`typecheck_demo\` must carry \`if: \${{ !cancelled() }}\`, or a failing earlier step skips it (found ${JSON.stringify(demoStep.condition)}).`);
    }
  }
  for (const stepId of ['typecheck', 'typecheck_demo']) {
    if (!summaryReportsOutcome(jobLines, stepId)) {
      problems.push(`ci.yml summary step does not report steps.${stepId}.outcome, so a red \`${stepId}\` step would not fail the job.`);
    }
  }

  return problems;
}

// ---------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------

describe('demo-tier typecheck program: the real files', () => {
  it('reads the files and the job it is meant to guard (proves the scan still matches)', () => {
    expect(fs.existsSync(path.join(REPO_ROOT, 'tsconfig.json')), 'tsconfig.demo.json extends this file').toBe(true);
    expect(fs.existsSync(path.join(REPO_ROOT, 'tsconfig.demo.json'))).toBe(true);

    const jobLines = readJobLines(readSources().ciYml, 'checks');
    expect(jobLines, 'ci.yml `checks` job was not found').not.toBeNull();
    const stepIds = readSteps(jobLines ?? []).map((step) => step.id);
    // Known steps of the job: if the step reader stopped matching, none of these would be found
    // and every later assertion would pass or fail for the wrong reason.
    expect(stepIds).toEqual(expect.arrayContaining(['lint', 'typecheck', 'typecheck_demo', 'build']));
  });

  it('has the program, the scripts and the CI step wired', () => {
    const problems = findTypecheckWiringProblems(readSources());
    expect(problems, problems.join('\n')).toEqual([]);
  });
});

describe('findTypecheckWiringProblems', () => {
  interface RedCase {
    title: string;
    file: keyof TypecheckWiringSources;
    needle: string;
    replacement: string;
    expectedProblem: RegExp;
  }

  const redCases: RedCase[] = [
    {
      title: 'tsconfig.demo.json stops extending the root config',
      file: 'tsconfigDemo',
      needle: '"./tsconfig.json"',
      replacement: '"./tsconfig.node.json"',
      expectedProblem: /must extend "\.\/tsconfig\.json"/,
    },
    {
      title: 'tsconfig.demo.json include drops demo/',
      file: 'tsconfigDemo',
      needle: ', "demo/**/*.ts"',
      replacement: '',
      expectedProblem: /include does not cover demo,/,
    },
    {
      title: 'tsconfig.demo.json include drops tests/captures',
      file: 'tsconfigDemo',
      needle: '"tests/captures/**/*.ts", ',
      replacement: '',
      expectedProblem: /include does not cover tests\/captures/,
    },
    {
      title: 'tsconfig.demo.json include drops tests/demo',
      file: 'tsconfigDemo',
      needle: '"tests/demo/**/*.ts", ',
      replacement: '',
      expectedProblem: /include does not cover tests\/demo/,
    },
    {
      title: 'the typecheck script reverts to the root program alone',
      file: 'packageJson',
      needle: '"npm run typecheck:src && npm run typecheck:demo"',
      replacement: '"tsc --noEmit"',
      expectedProblem: /"typecheck" must run "npm run typecheck:demo"/,
    },
    {
      title: 'the typecheck script stops running the root program',
      file: 'packageJson',
      needle: '"npm run typecheck:src && npm run typecheck:demo"',
      replacement: '"npm run typecheck:demo"',
      expectedProblem: /"typecheck" must run "npm run typecheck:src"/,
    },
    {
      title: 'typecheck:demo loses -p tsconfig.demo.json',
      file: 'packageJson',
      needle: '"tsc --noEmit -p tsconfig.demo.json"',
      replacement: '"tsc --noEmit"',
      expectedProblem: /"typecheck:demo" must be tsc with "-p tsconfig\.demo\.json"/,
    },
    {
      title: 'typecheck:src is pointed at the demo program',
      file: 'packageJson',
      needle: '"typecheck:src": "tsc --noEmit"',
      replacement: '"typecheck:src": "tsc --noEmit -p tsconfig.demo.json"',
      expectedProblem: /"typecheck:src" must be the root program/,
    },
    {
      title: 'the ci.yml typecheck step goes back to the chained script',
      file: 'ciYml',
      needle: 'run: npm run typecheck:src',
      replacement: 'run: npm run typecheck',
      expectedProblem: /step `typecheck` must run exactly "npm run typecheck:src"/,
    },
    {
      title: 'the ci.yml demo step runs the chained script instead of typecheck:demo',
      file: 'ciYml',
      needle: 'run: npm run typecheck:demo',
      replacement: 'run: npm run typecheck',
      expectedProblem: /step `typecheck_demo` must run exactly "npm run typecheck:demo"/,
    },
    {
      title: 'the ci.yml demo step is renamed away from typecheck_demo',
      file: 'ciYml',
      needle: 'id: typecheck_demo',
      replacement: 'id: typecheck_demo_renamed',
      expectedProblem: /no step with id `typecheck_demo`/,
    },
    {
      title: 'the ci.yml demo step loses its !cancelled() guard',
      file: 'ciYml',
      needle: '        id: typecheck_demo\n        if: ${{ !cancelled() }}\n',
      replacement: '        id: typecheck_demo\n',
      expectedProblem: /step `typecheck_demo` must carry `if: \$\{\{ !cancelled\(\) \}\}`/,
    },
    {
      title: 'the ci.yml summary stops reporting the demo step',
      file: 'ciYml',
      needle: '          check "Type check demo tier (tsc)" "${{ steps.typecheck_demo.outcome }}"\n',
      replacement: '',
      expectedProblem: /summary step does not report steps\.typecheck_demo\.outcome/,
    },
    {
      title: 'the ci.yml summary stops reporting the root typecheck step',
      file: 'ciYml',
      needle: '          check "Type check (tsc)" "${{ steps.typecheck.outcome }}"\n',
      replacement: '',
      expectedProblem: /summary step does not report steps\.typecheck\.outcome/,
    },
  ];

  it.each(redCases)('reports it when $title', ({ file, needle, replacement, expectedProblem }) => {
    const sources = readSources();
    const regressed: TypecheckWiringSources = { ...sources, [file]: replaceExactly(sources[file], needle, replacement) };
    const problems = findTypecheckWiringProblems(regressed);
    expect(problems.length, 'the mutation produced no problem, so the pin is blind to it').toBeGreaterThan(0);
    expect(problems.some((problem) => expectedProblem.test(problem)), `no problem matched ${expectedProblem}. Got:\n${problems.join('\n')}`).toBe(true);
  });

  it('reports a missing checks job rather than passing against nothing', () => {
    const problems = findTypecheckWiringProblems({ ...readSources(), ciYml: 'name: Empty\njobs:\n  other:\n    runs-on: ubuntu-24.04\n' });
    expect(problems).toContain('ci.yml has no `checks` job under `jobs:`.');
  });

  it('does not mistake a with: entry or a script body for a step field', () => {
    const jobLines = readJobLines(
      [
        'jobs:',
        '  checks:',
        '    steps:',
        '      - name: Cache',
        '        uses: actions/cache@v6',
        '        with:',
        '          id: not-a-step-id',
        '      - name: Summarize',
        '        run: |',
        '          id: also-not-a-step-id',
        '  later:',
        '    steps:',
        '      - id: belongs-to-another-job',
      ].join('\n'),
      'checks',
    );
    expect(readSteps(jobLines ?? []).map((step) => step.id)).toEqual([null, null]);
  });
});
