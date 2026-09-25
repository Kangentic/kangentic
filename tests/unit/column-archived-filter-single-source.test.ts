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
import { hasOptOutMarker } from './helpers/opt-out-marker';

const COMMANDS_DIR = path.join(__dirname, '..', '..', 'src', 'main', 'agent', 'commands');

/** The one file allowed to decide what "archived" means for a swimlane. */
const OWNER_FILE = 'column-resolver.ts';

/**
 * A hand-rolled archived test on a swimlane-ish binding. Deliberately narrow: it
 * matches `<something>.is_archived` where the receiver name mentions a swimlane,
 * lane, or column, so a task's `archived_at` and the `matched.is_archived`
 * display line in get_column_detail (which reports a resolved column's state
 * rather than filtering a list) are not swept up.
 *
 * Not global: every use below is a `.test()`, and a `/g` regex carries
 * `lastIndex` between them, so it answers false on alternate calls and the scan
 * passes vacuously.
 */
const HAND_ROLLED = /!\s*(\w*(?:swimlane|lane|column)\w*)\.is_archived/i;

/**
 * Per-line opt-out for a site that genuinely needs its own predicate, read
 * through the shared reader (`helpers/opt-out-marker.ts`). That replaced a
 * private "this line or the one above" rule, which silently failed to mark a
 * site whose reason wrapped onto a second line, and accepted a bare
 * `archived-filter-ok:` with no reason at all.
 */
const OPT_OUT = 'archived-filter-ok';

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
        if (!HAND_ROLLED.test(line)) return;
        if (hasOptOutMarker(lines, index, OPT_OUT)) return;
        offenders.push(`${fileName}:${index + 1}  ${line.trim()}`);
      });
    }

    expect(
      offenders,
      `Hand-rolled swimlane archived filter(s) found. The done column is persisted archived, so `
      + `this drops it. Use listBoardColumns / isBoardColumn (read tools) or listActiveSwimlanes `
      + `(move targets) from column-resolver.ts, or mark the line (or the comment block directly `
      + `above it) "// ${OPT_OUT}: <reason>" - the reason is required:\n`
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
    expect(HAND_ROLLED.test(shipped)).toBe(true);
  });

  it('does not flag a task\'s own archived state', () => {
    expect(HAND_ROLLED.test('const live = tasks.filter((task) => !task.archived_at);')).toBe(false);
  });

  it('requires a reason on the opt-out, and ignores prose that quotes it', () => {
    // The two properties the shared reader added here. A bare marker used to
    // waive the line, and a comment explaining why a site is NOT exempt used to
    // read as the exemption.
    const offence = '  const lanes = all.filter((swimlane) => !swimlane.is_archived);';
    expect(hasOptOutMarker([`${offence} // ${OPT_OUT}:`], 0, OPT_OUT)).toBe(false);
    expect(hasOptOutMarker([`${offence} // deliberately not an \`${OPT_OUT}:\` site`], 0, OPT_OUT)).toBe(false);
    expect(hasOptOutMarker([`${offence} // ${OPT_OUT}: reports state, does not filter`], 0, OPT_OUT)).toBe(true);
  });

  it('accepts a reason that wraps onto a second line', () => {
    // The bug the shared reader exists to fix: under the old "this line or the
    // one above" rule the nearest line was the tail of the reason, not the
    // marker, so the site went unmarked and the message said to add a marker
    // that was already there.
    const lines = [
      `  // ${OPT_OUT}: get_column_detail reports a resolved column's own state`,
      '  // rather than filtering a list, so the shared helper does not apply.',
      '  const lanes = all.filter((swimlane) => !swimlane.is_archived);',
    ];
    expect(hasOptOutMarker(lines, 2, OPT_OUT)).toBe(true);
  });
});
