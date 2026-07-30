import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// The task-detail surface is a TASK-scoped surface, and
// .claude/rules/pop-out-surface-registry.md already states the rule: "task-scoped
// surfaces resolve their own data from params ({ taskId, projectId }), never from
// ambient currentProject/currentTask state". It read ambient state anyway, which
// is invisible while the only host is the board (whose task is always the current
// project's) and silently WRONG the moment a second host shows a task from another
// project: edits, moves, branch resolution and transcripts would all land in
// whichever project happened to be open.
//
// The fix is `task-detail-host.tsx`, a context each host implements. This scan is
// the backstop: a future edit that reaches for `useProjectStore` or `useBoardStore`
// inside the surface compiles and passes every existing test, because the board
// host makes the two agree. Only a cross-project host disagrees, and by then the
// bug is a data-corruption bug in someone's other project.

const REPO_ROOT = path.resolve(__dirname, '../..');
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);

/** The surface: everything that renders inside a TaskDetailHostProvider. */
const SCAN_TARGETS = [
  'src/renderer/components/dialogs/task-detail',
  'src/renderer/window-manager/components/TaskDetailWindow.tsx',
];

/**
 * The host implementation is the ONE place allowed to read the ambient stores:
 * that is its entire job, and it is per-host by construction.
 */
const ALLOWLIST = [
  'src/renderer/components/dialogs/task-detail/BoardTaskDetailHost.tsx',
];

/** An import of a store whose contents are scoped to the CURRENTLY OPEN project. */
const AMBIENT_PROJECT_STORE_IMPORT = /from\s+['"][^'"]*stores\/(project-store|board-store)['"]/;
/** A direct read of the open project, even without the import (re-exported paths). */
const AMBIENT_CURRENT_PROJECT_READ = /currentProject/;

function collectSourceFiles(target: string): string[] {
  const fullPath = path.join(REPO_ROOT, target);
  if (!fs.existsSync(fullPath)) return [];
  if (fs.statSync(fullPath).isFile()) return [fullPath];

  const files: string[] = [];
  for (const entry of fs.readdirSync(fullPath, { withFileTypes: true })) {
    const entryPath = path.join(fullPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(path.join(target, entry.name)));
    } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(entryPath);
    }
  }
  return files;
}

function toPosix(absolutePath: string): string {
  return path.relative(REPO_ROOT, absolutePath).replace(/\\/g, '/');
}

describe('task-detail host decoupling', () => {
  const files = SCAN_TARGETS.flatMap(collectSourceFiles)
    .filter((file) => !ALLOWLIST.includes(toPosix(file)));

  it('scans a non-empty set of files', () => {
    // Guards against the scan silently covering nothing after a move or rename.
    expect(files.length).toBeGreaterThan(5);
  });

  it('never reads the open project or board from inside the surface', () => {
    const offenders: string[] = [];

    for (const file of files) {
      const lines = fs.readFileSync(file, 'utf-8').split('\n');
      lines.forEach((line, index) => {
        // Skip comments: this rule is explained in prose in several of these files.
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
        if (AMBIENT_PROJECT_STORE_IMPORT.test(line) || AMBIENT_CURRENT_PROJECT_READ.test(line)) {
          offenders.push(`${toPosix(file)}:${index + 1}: ${trimmed}`);
        }
      });
    }

    expect(
      offenders,
      'The task-detail surface must read project-scoped values from useTaskDetailHost(), '
      + 'not from the project/board stores. Add the value to TaskDetailHostValue and supply it '
      + 'from each host (BoardTaskDetailHost, and the Agent Monitor\'s). Offenders:\n'
      + offenders.join('\n'),
    ).toEqual([]);
  });

  it('the board host still supplies every field the context declares', () => {
    // A field added to the interface but never provided is a runtime `undefined`
    // that TypeScript catches - unless the host builds its object dynamically.
    // Assert the board host names each one, so the failure is a test, not a crash.
    const contextSource = fs.readFileSync(
      path.join(REPO_ROOT, 'src/renderer/components/dialogs/task-detail/task-detail-host.tsx'),
      'utf-8',
    );
    const boardHostSource = fs.readFileSync(
      path.join(REPO_ROOT, 'src/renderer/components/dialogs/task-detail/BoardTaskDetailHost.tsx'),
      'utf-8',
    );

    const interfaceBody = contextSource.split('export interface TaskDetailHostValue {')[1]
      ?.split('\n}')[0] ?? '';
    const fieldNames = [...interfaceBody.matchAll(/^\s{2}(\w+)[?:(]/gm)].map((match) => match[1]);

    expect(fieldNames.length).toBeGreaterThan(8);
    for (const field of fieldNames) {
      expect(boardHostSource, `BoardTaskDetailHost does not supply "${field}"`).toContain(field);
    }
  });
});
