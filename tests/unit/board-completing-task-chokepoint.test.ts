import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Enforces .claude/rules/board-completing-task-chokepoint.md. Tasks mid-completion
// (dropped on Done, flying into the dropzone) are excluded from the board at exactly
// one place: KanbanBoard's `tasksPerLane` memo, which reads `completingTaskIds` and
// keeps the task out of EVERY lane during the ~700ms fly. The drag-to-Done "card
// flashes back to its source column" bug recurred 5+ times because the guard was
// applied per-lane (DoneSwimlane only) instead of at that single chokepoint, leaving
// the source lane unguarded against a loadBoard() racing the fly.
//
// This scan fails if any board lane component other than KanbanBoard.tsx references
// either guard, i.e. re-implements the filter per-lane. The producer side
// (addCompletingTaskId / removeCompletingTaskId / pinTaskLane / dropTaskLanePin and
// the state definitions) lives in the board store, outside this directory, so it is
// naturally out of scope.
//
// `lanePins` is the second guard, added for the same bug class on the non-Done side:
// a cross-lane move's optimistic placement was clobbered by a loadBoard() whose
// tasks.list() was issued before the move's DB write, so the card snapped back to its
// source column. completingTaskIds EXCLUDES a task from every lane; lanePins REDIRECTS
// one to a different lane. Both are read only at tasksPerLane, for the same reason: it
// is the single place `tasks` is bucketed into per-lane arrays, so a guard applied
// there is reconciliation-proof, and a guard applied per-lane protects only that lane.

const REPO_ROOT = path.resolve(__dirname, '../..');
const SCAN_DIR = 'src/renderer/components/board';
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);
const GUARD_IDENTIFIERS = ['completingTaskIds', 'lanePins'];

// The single chokepoint allowed to read the Set.
const ALLOWED_FILES = new Set(['src/renderer/components/board/KanbanBoard.tsx']);

function collectSourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(fullPath));
    } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(fullPath);
    }
  }
  return files;
}

function toPosix(relativePath: string): string {
  return relativePath.replace(/\\/g, '/');
}

describe('lane membership is overridden only at the tasksPerLane chokepoint', () => {
  it.each(GUARD_IDENTIFIERS)('no board lane component except KanbanBoard reads %s', (guard) => {
    const offenders: string[] = [];
    const absoluteDir = path.join(REPO_ROOT, SCAN_DIR);
    for (const filePath of collectSourceFiles(absoluteDir)) {
      const relative = toPosix(path.relative(REPO_ROOT, filePath));
      if (ALLOWED_FILES.has(relative)) continue;
      const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
      lines.forEach((line, index) => {
        if (line.includes(guard)) {
          offenders.push(`${relative}:${index + 1}`);
        }
      });
    }
    expect(
      offenders,
      `Board lane components must not re-derive lane membership from ${guard}. Both guards are read ` +
        `once at KanbanBoard's tasksPerLane chokepoint: completingTaskIds keeps a completing task out ` +
        `of EVERY lane (source and Done) for the whole fly, and lanePins holds a moving task at its ` +
        `destination until the server confirms the move. A per-lane filter only ever protects the lane ` +
        `that implements it. See .claude/rules/board-completing-task-chokepoint.md.\nOffenders:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('KanbanBoard actually reads both guards (the scan above is not vacuous)', () => {
    const chokepoint = fs.readFileSync(
      path.join(REPO_ROOT, 'src/renderer/components/board/KanbanBoard.tsx'),
      'utf-8',
    );
    for (const guard of GUARD_IDENTIFIERS) {
      expect(chokepoint, `KanbanBoard must read ${guard} at tasksPerLane`).toContain(guard);
    }
  });
});
