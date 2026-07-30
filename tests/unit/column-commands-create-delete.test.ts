/**
 * Unit tests for the MCP `create_column` / `delete_column` handlers.
 *
 * Run against a real in-memory SQLite DB rather than a SQL-substring mock: the
 * whole point of `delete_column` is that it removes rows in OTHER tables
 * (swimlane_transitions) and nulls a self-referencing column
 * (swimlanes.plan_exit_target_id) inside a transaction. A mock that pattern-matches
 * SQL would assert that we issued the statements, not that they had any effect,
 * which is exactly the class of bug this tool exists to avoid.
 *
 * Skips cleanly when better-sqlite3 cannot load under the runner's Node ABI
 * (NODE_MODULE_VERSION mismatch under plain system Node); CI resolves the
 * correct ABI at build time. Mirrors swimlane-repository.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type DatabaseType from 'better-sqlite3';

function probeBetterSqlite3(): typeof DatabaseType | null {
  try {
    const moduleName = 'better-sqlite3';
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nativeModule = require(moduleName) as unknown;
    const databaseConstructor = (
      (nativeModule as { default?: typeof DatabaseType }).default ?? nativeModule
    ) as typeof DatabaseType;
    const probeHandle = new databaseConstructor(':memory:');
    probeHandle.close();
    return databaseConstructor;
  } catch {
    return null;
  }
}

const Database = probeBetterSqlite3();
const CAN_RUN = Database !== null;

import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { SwimlaneRepository } from '../../src/main/db/repositories/swimlane-repository';
import { handleCreateColumn, handleDeleteColumn, handleUpdateColumn } from '../../src/main/agent/commands/column-commands';
import type { CommandContext } from '../../src/main/agent/commands/types';
import type { BoardProfile } from '../../src/shared/types';

describe.runIf(CAN_RUN)('handleCreateColumn / handleDeleteColumn', () => {
  let db: InstanceType<typeof DatabaseType>;
  let repository: SwimlaneRepository;
  let profiles: BoardProfile[];
  let context: CommandContext;

  function makeContext(): CommandContext {
    return {
      getProjectDb: () => db,
      getProjectPath: () => 'C:/Users/dev/project',
      getBoardProfiles: () => profiles,
      setBoardProfiles: vi.fn((next: BoardProfile[]) => { profiles = next; }),
      onTaskCreated: vi.fn(),
      onTaskUpdated: vi.fn(),
      onTaskDeleted: vi.fn(),
      onTaskMove: vi.fn().mockResolvedValue(undefined),
      onSwimlaneUpdated: vi.fn(),
      onSwimlaneDeleted: vi.fn(),
      onBacklogChanged: vi.fn(),
      onLabelColorsChanged: vi.fn(),
    };
  }

  beforeEach(() => {
    if (!Database) return;
    db = new Database(':memory:');
    runProjectMigrations(db);
    repository = new SwimlaneRepository(db);
    profiles = [];
    context = makeContext();
  });

  afterEach(() => {
    db?.close();
  });

  // -------------------------------------------------------------------------
  // create_column
  // -------------------------------------------------------------------------

  it('creates a column just before Done by default', () => {
    const response = handleCreateColumn({ name: 'Brand Review' }, context);

    expect(response.success).toBe(true);
    const names = repository.list().map((lane) => lane.name);
    const doneIndex = names.indexOf('Done');
    expect(names.indexOf('Brand Review')).toBe(doneIndex - 1);
  });

  it('refuses a name that collides with an existing column, case-insensitively', () => {
    handleCreateColumn({ name: 'Brand Review' }, context);
    const response = handleCreateColumn({ name: '  brand review  ' }, context);

    expect(response.success).toBe(false);
    expect(response.error).toContain('already exists');
    expect(repository.list().filter((lane) => lane.name === 'Brand Review')).toHaveLength(1);
  });

  it('refuses a name colliding with archived Done, which resolveColumn hides', () => {
    // Done is stored archived, so a duplicate check that only looked at
    // resolvable lanes would let a second "Done" through and leave the board
    // with two lanes sharing a name - which apply-config.ts then rejects.
    const response = handleCreateColumn({ name: 'Done' }, context);

    expect(response.success).toBe(false);
    expect(response.error).toContain('already exists');
  });

  it('requires a name', () => {
    expect(handleCreateColumn({}, context).success).toBe(false);
    expect(handleCreateColumn({ name: '   ' }, context).success).toBe(false);
  });

  it('shifts existing columns when an explicit position is given, so no two share a slot', () => {
    // The repository takes an explicit position RAW with no shift; the handler
    // has to make room itself. Red trigger: drop the UPDATE ... position + 1 in
    // handleCreateColumn and two lanes end up at position 1.
    const response = handleCreateColumn({ name: 'Brand Review', position: 1 }, context);

    expect(response.success).toBe(true);
    const positions = repository.list().map((lane) => lane.position);
    expect(new Set(positions).size).toBe(positions.length);
    expect(repository.list()[1].name).toBe('Brand Review');
  });

  it('an explicit position: 0 does not displace To Do; the new column lands at ordinal index 1', () => {
    // `position` is a zero-based ORDINAL slot, clamped between the role columns:
    // slot 0 belongs to To Do, which is never a legal home for a role-less
    // column. Red trigger: an earlier version took `position` as a raw value
    // with only `Math.min(requested, existingLanes.length)` clamping it, so
    // `position: 0` collided with To Do at raw position 0. That wedges every
    // later reorder: SwimlaneRepository.reorder throws 'Custom columns cannot
    // be at the first position.' for any order whose first id has no role.
    const response = handleCreateColumn({ name: 'Brand Review', position: 0 }, context);

    expect(response.success).toBe(true);
    const lanes = repository.list();
    expect(lanes[0].role).toBe('todo');
    expect(lanes[1].name).toBe('Brand Review');
    const positions = lanes.map((lane) => lane.position);
    expect(new Set(positions).size).toBe(positions.length);
  });

  it('a position far past the end (999) lands the column immediately before Done, never after it', () => {
    // Symmetric clamp to the position:0 case above: the highest legal slot is
    // Done's own ordinal index, never past it. Red trigger: an unclamped
    // `position` would have `apply-config.ts` silently relocate the column on
    // the next project open, since it always re-sorts Done last.
    const response = handleCreateColumn({ name: 'Brand Review', position: 999 }, context);

    expect(response.success).toBe(true);
    const lanes = repository.list();
    expect(lanes[lanes.length - 1].role).toBe('done');
    expect(lanes[lanes.length - 2].name).toBe('Brand Review');
    const positions = lanes.map((lane) => lane.position);
    expect(new Set(positions).size).toBe(positions.length);
  });

  it('resolves an explicit position as an ORDINAL slot, not a raw position, across a gap left by a prior delete', () => {
    // Build a positional gap: create three columns (default placement, no
    // explicit position), then delete the middle one. handleDeleteColumn's
    // underlying delete (deleteSwimlaneRowWithReferences) does NOT renumber the
    // survivors, so the board is left sitting at raw positions
    // 0,1,2,3,4,5,6,8,9 - position 7 (Column B's old slot) is a permanent hole.
    handleCreateColumn({ name: 'Column A' }, context);
    handleCreateColumn({ name: 'Column B' }, context);
    handleCreateColumn({ name: 'Column C' }, context);
    handleDeleteColumn({ column: 'Column B' }, context);

    const beforeCreate = repository.list();
    const doneOrdinalIndex = beforeCreate.findIndex((lane) => lane.role === 'done');

    // Red trigger: an ordinal-blind fix would take this clamped ordinal
    // directly as the raw `position` value to sweep and insert at. Because raw
    // position 7 is a hole, that raw value (the ordinal itself, 8) coincides
    // with Column C's own raw position - so the buggy read sweeps Column C
    // forward and lands the new column at Column C's ordinal slot, one slot
    // early, instead of immediately before Done as requested.
    const response = handleCreateColumn({ name: 'Gap Fill', position: doneOrdinalIndex }, context);

    expect(response.success).toBe(true);
    const lanes = repository.list();
    expect(lanes[doneOrdinalIndex].name).toBe('Gap Fill');
    expect(lanes[doneOrdinalIndex + 1].role).toBe('done');
    const positions = lanes.map((lane) => lane.position);
    expect(new Set(positions).size).toBe(positions.length);
  });

  it('rejects a negative or non-integer position', () => {
    expect(handleCreateColumn({ name: 'A', position: -1 }, context).success).toBe(false);
    expect(handleCreateColumn({ name: 'B', position: 1.5 }, context).success).toBe(false);
  });

  it('applies the optional configuration fields', () => {
    handleCreateColumn({
      name: 'Brand Review',
      description: 'Checks brand voice',
      color: '#71717a',
      autoSpawn: false,
      autoCommand: '/review --brand',
      modelOverride: 'opus',
      permissionMode: 'plan',
    }, context);

    const created = repository.list().find((lane) => lane.name === 'Brand Review');
    expect(created?.description).toBe('Checks brand voice');
    expect(created?.color).toBe('#71717a');
    expect(created?.auto_spawn).toBe(false);
    expect(created?.auto_command).toBe('/review --brand');
    expect(created?.model_override).toBe('opus');
    expect(created?.permission_mode).toBe('plan');
  });

  it('rejects an invalid permissionMode instead of storing it', () => {
    const response = handleCreateColumn({ name: 'Brand Review', permissionMode: 'yolo' }, context);

    expect(response.success).toBe(false);
    expect(response.error).toContain('Invalid permissionMode');
    expect(repository.list().some((lane) => lane.name === 'Brand Review')).toBe(false);
  });

  // -------------------------------------------------------------------------
  // delete_column - refusals
  // -------------------------------------------------------------------------

  it('refuses to delete the To Do role column', () => {
    const response = handleDeleteColumn({ column: 'To Do' }, context);

    expect(response.success).toBe(false);
    expect(response.error).toContain('todo column');
    expect(repository.list().some((lane) => lane.role === 'todo')).toBe(true);
  });

  it('refuses to delete Done as a ROLE column, not as "not found"', () => {
    // Done is stored archived and resolveColumn hides archived lanes by default,
    // so without includeArchivedDone this reports a bare "Column not found" and
    // the caller never learns the real reason. Red trigger: drop the flag.
    const response = handleDeleteColumn({ column: 'Done' }, context);

    expect(response.success).toBe(false);
    expect(response.error).toContain('done column');
    expect(response.error).not.toContain('not found');
  });

  it('refuses to delete a column that still holds tasks, and names the count', () => {
    const lane = repository.create({ name: 'Brand Review' });
    db.prepare(
      "INSERT INTO tasks (id, title, swimlane_id, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run('task-1', 'A task', lane.id, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');

    const response = handleDeleteColumn({ column: 'Brand Review' }, context);

    expect(response.success).toBe(false);
    expect(response.error).toContain('1 task(s)');
    expect(repository.getById(lane.id)).toBeDefined();
  });

  it('reports an unknown column rather than throwing', () => {
    const response = handleDeleteColumn({ column: 'Nope' }, context);

    expect(response.success).toBe(false);
    expect(response.error).toContain('not found');
  });

  it('requires a column argument', () => {
    expect(handleDeleteColumn({}, context).success).toBe(false);
  });

  // -------------------------------------------------------------------------
  // delete_column - the reference cleanup
  // -------------------------------------------------------------------------

  it('deletes an empty column and notifies via onSwimlaneDeleted', () => {
    const lane = repository.create({ name: 'Brand Review' });

    const response = handleDeleteColumn({ column: 'Brand Review' }, context);

    expect(response.success).toBe(true);
    expect(repository.getById(lane.id)).toBeUndefined();
    // Load-bearing: this callback owns the kangentic.json write-back, without
    // which the file re-creates the column on the next project open.
    expect(context.onSwimlaneDeleted).toHaveBeenCalledOnce();
  });

  it('clears another column\'s plan_exit_target_id pointing at the deleted one', () => {
    const target = repository.create({ name: 'Brand Review' });
    // Not "Planning" - the seeded board already has one, and a duplicate name
    // here would muddy the assertion.
    const planner = repository.create({ name: 'Plan Gate' });
    repository.update({ id: planner.id, plan_exit_target_id: target.id });

    const response = handleDeleteColumn({ column: 'Brand Review' }, context);

    expect(response.success).toBe(true);
    expect(repository.getById(planner.id)?.plan_exit_target_id).toBeNull();
    expect(response.message).toContain('plan-exit reference');
  });

  it('removes swimlane_transitions rows on both sides of the deleted column', () => {
    const lane = repository.create({ name: 'Brand Review' });
    db.prepare("INSERT INTO actions (id, name, type, config_json, created_at) VALUES (?, ?, ?, ?, ?)")
      .run('action-1', 'Ping', 'webhook', '{}', '2026-01-01T00:00:00.000Z');
    db.prepare('INSERT INTO swimlane_transitions (id, from_swimlane_id, to_swimlane_id, action_id, execution_order) VALUES (?, ?, ?, ?, ?)')
      .run('transition-1', '*', lane.id, 'action-1', 0);

    const response = handleDeleteColumn({ column: 'Brand Review' }, context);

    expect(response.success).toBe(true);
    const remaining = db
      .prepare('SELECT COUNT(*) as count FROM swimlane_transitions WHERE from_swimlane_id = ? OR to_swimlane_id = ?')
      .get(lane.id, lane.id) as { count: number };
    expect(remaining.count).toBe(0);
    expect(response.message).toContain('transition');
  });

  it('prunes board-profile entries keyed to the deleted column, and planExitTargets naming it', () => {
    // Profiles live in kangentic.json with no FK, so nothing in the DB layer
    // reaches them. Red trigger: drop the pruneDeletedColumnFromProfiles call
    // and both references survive the delete.
    const lane = repository.create({ name: 'Brand Review' });
    profiles = [{
      id: 'profile-1',
      name: 'Heavy',
      columns: {
        [lane.id]: { modelOverride: 'opus' },
        'other-lane': { planExitTarget: 'Brand Review' },
      },
    }];

    const response = handleDeleteColumn({ column: 'Brand Review' }, context);

    expect(response.success).toBe(true);
    expect(profiles[0].columns).not.toHaveProperty(lane.id);
    expect(profiles[0].columns['other-lane']).not.toHaveProperty('planExitTarget');
    expect(response.message).toContain('board-profile entr');
  });

  it('leaves profiles untouched, and unwritten, when none referenced the column', () => {
    repository.create({ name: 'Brand Review' });
    profiles = [{ id: 'profile-1', name: 'Heavy', columns: { 'other-lane': { modelOverride: 'opus' } } }];

    const response = handleDeleteColumn({ column: 'Brand Review' }, context);

    expect(response.success).toBe(true);
    expect(context.setBoardProfiles).not.toHaveBeenCalled();
    expect(response.message).not.toContain('board-profile');
  });

  // -------------------------------------------------------------------------
  // planExitTargetColumn resolves with includeArchivedDone - "plan, then move
  // straight to Done" was unreachable before this flag: Done is stored
  // archived, so resolveColumn's default filter hid it and both handlers
  // reported "Column not found" for a target that plainly exists. Covers both
  // handleCreateColumn (sets it at creation) and handleUpdateColumn (sets it
  // on an existing column), since each threads its own resolveColumn call.
  // -------------------------------------------------------------------------

  it('handleCreateColumn resolves planExitTargetColumn: "Done" via includeArchivedDone', () => {
    // Red trigger: drop the `{ includeArchivedDone: true }` options argument
    // from handleCreateColumn's resolveColumn call - Done is archived by
    // default, so the response would fail with "Column not found" instead.
    const response = handleCreateColumn({ name: 'Brand Review', planExitTargetColumn: 'Done' }, context);

    expect(response.success).toBe(true);
    const done = repository.list().find((lane) => lane.role === 'done');
    expect(done).toBeDefined();
    const created = repository.getById((response.data as { id: string }).id);
    expect(created?.plan_exit_target_id).toBe(done!.id);
  });

  it('handleCreateColumn reports an error for a genuinely unknown planExitTargetColumn, without creating the column', () => {
    const response = handleCreateColumn({ name: 'Brand Review', planExitTargetColumn: 'Nope' }, context);

    expect(response.success).toBe(false);
    expect(response.error).toContain('planExitTargetColumn');
    expect(repository.list().some((lane) => lane.name === 'Brand Review')).toBe(false);
  });

  it('handleUpdateColumn resolves planExitTargetColumn: "Done" via includeArchivedDone', () => {
    // Same red trigger as the create-side test above, against
    // handleUpdateColumn's own resolveColumn call.
    const lane = repository.create({ name: 'Brand Review' });

    const response = handleUpdateColumn({ column: 'Brand Review', planExitTargetColumn: 'Done' }, context);

    expect(response.success).toBe(true);
    const done = repository.list().find((swimlane) => swimlane.role === 'done');
    expect(done).toBeDefined();
    expect(repository.getById(lane.id)?.plan_exit_target_id).toBe(done!.id);
  });

  it('handleUpdateColumn reports an error for a genuinely unknown planExitTargetColumn, without changing the column', () => {
    const lane = repository.create({ name: 'Brand Review' });

    const response = handleUpdateColumn({ column: 'Brand Review', planExitTargetColumn: 'Nope' }, context);

    expect(response.success).toBe(false);
    expect(response.error).toContain('planExitTargetColumn');
    expect(repository.getById(lane.id)?.plan_exit_target_id).toBeNull();
  });
});
