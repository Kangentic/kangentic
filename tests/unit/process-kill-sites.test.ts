/**
 * Every place Kangentic can end a process it did not just start through its
 * own handle, so none can end a stranger's process through a pid Windows has
 * handed on.
 *
 * A Windows process keeps its parent's pid after the parent exits, and Windows
 * reuses pids. A tree kill that walks recorded parent pids without comparing
 * creation times takes a stranger's tree; a kill by a pid nothing pins can take
 * the stranger that now holds it. The rules each site follows are in
 * `src/main/shared/child-tree-stop.ts` (taskkill, and when a pid is pinned) and
 * `src/main/pty/process-tag/reap-plan.ts` (the reap's walks), and
 * `.claude/rules/task-process-tag.md` names them. This scan keeps the set of
 * sites closed: a new one fails here until it is classified with its reason,
 * and a tree-kill package that follows parent pids never enters the app.
 *
 * Out of scope: `ChildProcess.kill()` and node-pty's `kill()`, which end the
 * process through the handle Node or node-pty already holds. The pty host pins
 * a PTY's root (`PinnedRoot`) for node-pty's console-list kill, and
 * `pty-teardown-grace.test.ts` keeps PTY kills in their allowlisted modules.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../..');
const SCANNED_ROOTS = ['src/main', 'src/devtools'];

type Primitive = 'taskkill' | 'terminate-process' | 'process-kill' | 'stop-process' | 'dotnet-kill' | 'wmic';

const PRIMITIVES: Record<Primitive, RegExp> = {
  taskkill: /\btaskkill\b/i,
  'terminate-process': /\b[Tt]erminateProcess\s*\(/,
  'process-kill': /\bprocess\.kill\s*\(/,
  'stop-process': /\bStop-Process\b/i,
  'dotnet-kill': /\.Kill\s*\(/,
  wmic: /\bwmic\b/i,
};

/** Every file that may hold a terminate primitive, which ones, and why it cannot reach a stranger. */
const CLASSIFIED_SITES: Record<string, { primitives: Primitive[]; reason: string }> = {
  'src/main/shared/child-tree-stop.ts': {
    primitives: ['taskkill', 'process-kill'],
    reason: 'the tree-stop helper: taskkill /T while a handle pins the root, or by pid where no handle survives; POSIX group signals',
  },
  'src/main/shutdown.ts': {
    primitives: ['taskkill', 'process-kill'],
    reason: 'the quit failsafe ends this process\'s own tree, whose root is this running process',
  },
  'src/main/git/zombie-reaper.ts': {
    primitives: ['taskkill', 'process-kill'],
    reason: 'the by-pid kill for the E2E janitor and the reaps off Windows; on Windows, once the pty host\'s Stop is registered, the reaps stop by identity',
  },
  'src/main/pty/process-tag/win32-reader.ts': {
    primitives: ['terminate-process'],
    reason: 'terminates only through a handle whose creation time it re-read',
  },
  'src/main/pty/process-tag/linux-reader.ts': {
    primitives: ['process-kill'],
    reason: 're-reads the process\'s start ticks before each signal',
  },
  'src/main/pty/process-tag/darwin-reader.ts': {
    primitives: ['process-kill'],
    reason: 're-reads the process\'s start key before each signal',
  },
  'src/main/shared/process-liveness.ts': {
    primitives: ['process-kill'],
    reason: 'a liveness probe: signal 0 ends nothing',
  },
  'src/devtools/main/lockfile.ts': {
    primitives: ['process-kill'],
    reason: 'a liveness probe: signal 0 ends nothing',
  },
};

/** Packages that end a tree by walking parent pids, without a creation-time check. */
const TREE_KILL_PACKAGES = ['tree-kill', 'ps-tree', 'pidtree', 'fkill', 'terminate', 'kill-process-tree'];

function sourceFiles(root: string): string[] {
  const absoluteRoot = path.join(REPO_ROOT, root);
  if (!fs.existsSync(absoluteRoot)) return [];
  return fs.readdirSync(absoluteRoot, { recursive: true, encoding: 'utf-8' })
    .filter((relative) => /\.(ts|tsx|js|cjs|mjs)$/.test(relative))
    .map((relative) => path.posix.join(root, relative.split(path.sep).join('/')));
}

/** The file's lines that are code: a line opening a comment is left out, as the other source scans do. */
function codeLines(file: string): string[] {
  return fs.readFileSync(path.join(REPO_ROOT, file), 'utf-8')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line));
}

const ALL_FILES = SCANNED_ROOTS.flatMap(sourceFiles);

describe('process kill sites', () => {
  it('finds terminate primitives only in classified files, and only the ones each is classified for', () => {
    const unclassified: string[] = [];
    for (const file of ALL_FILES) {
      const allowed = new Set(CLASSIFIED_SITES[file]?.primitives ?? []);
      for (const line of codeLines(file)) {
        for (const [primitive, pattern] of Object.entries(PRIMITIVES) as Array<[Primitive, RegExp]>) {
          if (pattern.test(line) && !allowed.has(primitive)) unclassified.push(`${file} (${primitive}): ${line.trim()}`);
        }
      }
    }
    expect(unclassified, 'classify the new site in CLASSIFIED_SITES with why it cannot end a stranger, or route it through child-tree-stop.ts').toEqual([]);
  });

  it('keeps every classified site real, so the list cannot go stale', () => {
    for (const [file, site] of Object.entries(CLASSIFIED_SITES)) {
      expect(fs.existsSync(path.join(REPO_ROOT, file)), file).toBe(true);
      const lines = codeLines(file);
      for (const primitive of site.primitives) {
        expect(lines.some((line) => PRIMITIVES[primitive].test(line)), `${file} no longer uses ${primitive}`).toBe(true);
      }
      expect(site.reason.length, file).toBeGreaterThan(20);
    }
  });

  it('runs every taskkill as a tree kill of one pid, /T /F, the form whose descent was measured', () => {
    for (const [file, site] of Object.entries(CLASSIFIED_SITES)) {
      if (!site.primitives.includes('taskkill')) continue;
      const source = codeLines(file).join('\n');
      // A quoted `taskkill` and the rest of its line plus the next one: every
      // call here spells its arguments within two lines (`'taskkill', ['/pid',
      // ...]` in child-tree-stop.ts, `'taskkill',` then the array on the next
      // line in zombie-reaper.ts, one template string in shutdown.ts). Only
      // text naming `/pid` is an invocation; a call split over more lines
      // fails the flag checks.
      const invocations = [...source.matchAll(/['"`]taskkill['"`]?\s*,?\s*\[?[^\n]*(?:\n[^\n]*)?/gi)]
        .map((match) => match[0])
        .filter((text) => /\/pid/i.test(text));
      expect(invocations.length, `${file} has a taskkill invocation`).toBeGreaterThan(0);
      for (const invocation of invocations) {
        expect(invocation, file).toMatch(/\/T\b/);
        expect(invocation, file).toMatch(/\/F\b/);
      }
    }
  });

  it('takes no tree-kill package that follows parent pids, and imports none', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8')) as Record<string, Record<string, string> | undefined>;
    const declared = new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
    ]);
    expect(TREE_KILL_PACKAGES.filter((name) => declared.has(name))).toEqual([]);
    const importPattern = new RegExp(`(?:from\\s+|require\\(\\s*|import\\(\\s*)['"](?:${TREE_KILL_PACKAGES.join('|')})['"]`);
    expect(ALL_FILES.filter((file) => importPattern.test(codeLines(file).join('\n')))).toEqual([]);
  });

  it('keeps the measured taskkill fact recorded where the tree stops live, with the probe that reruns it', () => {
    const header = fs.readFileSync(path.join(REPO_ROOT, 'src/main/shared/child-tree-stop.ts'), 'utf-8');
    expect(header).toContain('scripts/probe-taskkill-stale-parent.mjs');
    expect(header).toContain('tests/unit/taskkill-stale-parent.test.ts');
    expect(fs.existsSync(path.join(REPO_ROOT, 'scripts/probe-taskkill-stale-parent.mjs'))).toBe(true);
  });
});
