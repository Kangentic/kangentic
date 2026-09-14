/**
 * Nobody hand-rolls the swimlane archived filter.
 *
 * The done lane is persisted `is_archived = 1` by construction, so every
 * `!swimlane.is_archived` written by hand silently drops the column an agent
 * needs most. `column-resolver.ts` owns that decision in two functions
 * (`listActiveSwimlanes` for move targets, `listBoardColumns` for the read
 * tools) plus the `isBoardColumn` predicate.
 *
 * This is not hypothetical drift. `kangentic_list_columns` hid Done and sent a
 * finished task into Merge (task #642), and when that was fixed
 * `handleBoardSummary` turned out to be carrying its OWN copy of the same
 * filter, so the bug was two tools wide. A third copy is one careless line away,
 * and it fails silently: the tool keeps working, it just stops mentioning where
 * finished work goes.
 *
 * A static scan rather than a behavior test, because the failure mode is a NEW
 * call site that no existing test covers by definition.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const COMMANDS_DIR = path.join(__dirname, '..', '..', 'src', 'main', 'agent', 'commands');

/** The one file allowed to decide what "archived" means for a swimlane. */
const OWNER_FILE = 'column-resolver.ts';

/**
 * A hand-rolled archived test on a swimlane-ish binding. Deliberately narrow: it
 * matches `<something>.is_archived` where the receiver name mentions a swimlane,
 * lane, or column, so a task's `archived_at` and the `matched.is_archived`
 * display line in get_column_detail (which reports a resolved column's state
 * rather than filtering a list) are not swept up.
 */
const HAND_ROLLED = /!\s*(\w*(?:swimlane|lane|column)\w*)\.is_archived/gi;

/** Per-line opt-out for a site that genuinely needs its own predicate. */
const OPT_OUT = 'archived-filter-ok:';

function commandFiles(): string[] {
  return fs.readdirSync(COMMANDS_DIR)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .filter((name) => name !== OWNER_FILE);
}

describe('swimlane archived filtering has one source of truth', () => {
  it('finds no hand-rolled !swimlane.is_archived outside column-resolver.ts', () => {
    const offenders: string[] = [];

    for (const fileName of commandFiles()) {
      const lines = fs.readFileSync(path.join(COMMANDS_DIR, fileName), 'utf8').split('\n');
      lines.forEach((line, index) => {
        HAND_ROLLED.lastIndex = 0;
        if (!HAND_ROLLED.test(line)) return;
        if (line.includes(OPT_OUT)) return;
        const previous = index > 0 ? lines[index - 1] : '';
        if (previous.includes(OPT_OUT)) return;
        offenders.push(`${fileName}:${index + 1}  ${line.trim()}`);
      });
    }

    expect(
      offenders,
      `Hand-rolled swimlane archived filter(s) found. The done column is persisted archived, so `
      + `this drops it. Use listBoardColumns / isBoardColumn (read tools) or listActiveSwimlanes `
      + `(move targets) from column-resolver.ts, or mark the line "// ${OPT_OUT} <reason>":\n`
      + offenders.join('\n'),
    ).toEqual([]);
  });

  it('scans a real, non-empty set of files', () => {
    // Guards the scan against passing vacuously after a rename or a move.
    const files = commandFiles();
    expect(files).toContain('inventory-commands.ts');
    expect(files).toContain('analytics-commands.ts');
    expect(files.length).toBeGreaterThan(5);
  });

  it('would catch the copy that board_summary actually carried', () => {
    // The exact line handleBoardSummary shipped, so the pattern cannot be
    // loosened into uselessness without this going red.
    const shipped = '  const allSwimlanes = swimlaneRepo.list().filter((swimlane) => !swimlane.is_archived);';
    HAND_ROLLED.lastIndex = 0;
    expect(HAND_ROLLED.test(shipped)).toBe(true);
  });

  it('does not flag a task\'s own archived state', () => {
    HAND_ROLLED.lastIndex = 0;
    expect(HAND_ROLLED.test('const live = tasks.filter((task) => !task.archived_at);')).toBe(false);
  });
});
