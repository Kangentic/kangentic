/**
 * Parity between the production default-board seed and the UI tier's copy.
 *
 * Two independent literals describe the seven default columns: the real seed
 * in src/main/db/migrations/default-data.ts (what a new project gets) and
 * DEFAULT_SWIMLANES in tests/ui/mock-electron-api.js (what ~40 headless UI
 * specs render against). Nothing bound them before this test, so a rename or
 * field change in one tier left the other silently green against a board that
 * no longer ships.
 *
 * The real side runs the actual runProjectMigrations (which seeds when the
 * swimlanes table is empty) against node:sqlite, so the INSERT itself is
 * exercised: a column added to the `defaults` array but missing from the
 * INSERT statement fails here loudly. node:sqlite rather than better-sqlite3
 * on purpose: better-sqlite3 is compiled for Electron's Node ABI and every
 * suite gated on it skips everywhere, CI included (see the header of
 * tasks-run-mode-migration.test.ts). This suite skips only where node:sqlite
 * itself is unavailable (built-in on Node 22.5+; CI passes
 * --experimental-sqlite via vitest execArgv).
 *
 * The mock side is extracted from the browser IIFE by regex (the file
 * references `window` at module scope, so it cannot be imported here); the
 * array literal is pure data, and a regex miss fails the not-null guard
 * rather than passing vacuously.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { ICON_REGISTRY } from '../../src/renderer/utils/swimlane-icons';
import type DatabaseType from 'better-sqlite3';

type SqliteModule = typeof import('node:sqlite');
let sqlite: SqliteModule | null = null;
try {
  sqlite = await import('node:sqlite');
} catch {
  sqlite = null;
}

const describeWithSqlite = sqlite ? describe : describe.skip;

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const MOCK_FILE = path.join(REPO_ROOT, 'tests/ui/mock-electron-api.js');
const SEED_FILE = 'src/main/db/migrations/default-data.ts';

/**
 * Adapt node:sqlite's DatabaseSync to the slice of better-sqlite3's surface the migrations use.
 *
 * CAVEAT (same as worktree-folder-migration.test.ts and task-ordering-sql.test.ts, which carry
 * their own copies of this shim): `transaction` here is raw BEGIN/COMMIT, so unlike
 * better-sqlite3's savepoint-based version it does NOT nest. Nothing nests today - every
 * `db.transaction(...)` in the migration path is a leaf - but a future nested call would fail
 * with "cannot start a transaction within a transaction" in tests only, which is a confusing
 * thing to debug cold. Switch to SAVEPOINT if that happens.
 */
function adaptDatabase(database: InstanceType<SqliteModule['DatabaseSync']>): DatabaseType.Database {
  const adapter = {
    exec: (sql: string) => database.exec(sql),
    prepare: (sql: string) => database.prepare(sql),
    pragma: (statement: string) => database.prepare(`PRAGMA ${statement}`).all(),
    transaction: <Args extends unknown[], Result>(body: (...args: Args) => Result) =>
      (...args: Args): Result => {
        database.exec('BEGIN');
        try {
          const result = body(...args);
          database.exec('COMMIT');
          return result;
        } catch (error) {
          database.exec('ROLLBACK');
          throw error;
        }
      },
  };
  return adapter as unknown as DatabaseType.Database;
}

interface SeededLaneRow {
  id: string;
  name: string;
  description: string | null;
  role: string | null;
  position: number;
  color: string;
  icon: string;
  is_archived: number;
  is_ghost: number;
  permission_mode: string | null;
  auto_spawn: number;
  auto_command: string | null;
  auto_command_mode: string;
  plan_exit_target_id: string | null;
  agent_override: string | null;
  model_override: string | null;
  effort_override: string | null;
  handoff_context: number;
  session_target: string;
  session_spawn_strategy: string;
}

interface MockLane {
  name: string;
  description: string | null;
  role: string | null;
  color: string;
  icon: string;
  is_archived: boolean;
  is_ghost: boolean;
  permission_mode: string | null;
  auto_spawn: boolean;
  auto_command: string | null;
  auto_command_mode: string;
  plan_exit_target_id: string | null;
  agent_override: string | null;
  model_override: string | null;
  effort_override: string | null;
  handoff_context: boolean;
  session_target: string;
  session_spawn_strategy: string;
}

function seededLanes(): SeededLaneRow[] {
  const database = adaptDatabase(new sqlite!.DatabaseSync(':memory:'));
  runProjectMigrations(database);
  return database
    .prepare('SELECT * FROM swimlanes ORDER BY position')
    .all() as SeededLaneRow[];
}

function mockLanes(): MockLane[] {
  const mockSource = readFileSync(MOCK_FILE, 'utf8');
  const match = /var DEFAULT_SWIMLANES = (\[[\s\S]*?\n  \]);/.exec(mockSource);
  expect(match, `DEFAULT_SWIMLANES array literal not found in ${MOCK_FILE}`).not.toBeNull();
  // The literal is pure data (no identifiers), so evaluating it is safe.
  return new Function(`return ${match![1]};`)() as MockLane[];
}

describeWithSqlite('default swimlane seed parity (default-data.ts vs mock-electron-api.js)', () => {
  it('seeds the same seven columns, in the same order, in both tiers', () => {
    const seeded = seededLanes();
    const mock = mockLanes();

    expect(seeded.map((lane) => lane.name), `lane names in ${SEED_FILE}`).toEqual([
      'To Do', 'Planning', 'Executing', 'Code Review', 'Testing', 'Merge', 'Done',
    ]);
    expect(mock.map((lane) => lane.name), 'lane names in tests/ui/mock-electron-api.js').toEqual(
      seeded.map((lane) => lane.name),
    );
  });

  it('matches per-column fields between the seed and the mock', () => {
    const seeded = seededLanes();
    const mock = mockLanes();
    expect(mock.length).toBe(seeded.length);

    seeded.forEach((lane, index) => {
      const mockLane = mock[index];
      const where = `column ${index} ("${lane.name}")`;
      expect(mockLane.name, where).toBe(lane.name);
      expect(mockLane.description, where).toBe(lane.description);
      expect(mockLane.role, where).toBe(lane.role);
      expect(mockLane.color, where).toBe(lane.color);
      expect(mockLane.icon, where).toBe(lane.icon);
      expect(Number(mockLane.is_archived), where).toBe(lane.is_archived);
      expect(Number(mockLane.is_ghost), where).toBe(lane.is_ghost);
      expect(mockLane.permission_mode, where).toBe(lane.permission_mode);
      expect(Number(mockLane.auto_spawn), where).toBe(lane.auto_spawn);
      expect(mockLane.auto_command, where).toBe(lane.auto_command);
      // The fields below are never named by the seed's INSERT - they arrive
      // from the schema's column defaults. Asserted anyway, because the mock
      // hardcodes them: a future migration that changes one default would
      // otherwise desync the two tiers with this suite still green, which is
      // the exact silent drift the file exists to prevent.
      expect(mockLane.auto_command_mode, where).toBe(lane.auto_command_mode);
      expect(mockLane.agent_override, where).toBe(lane.agent_override);
      expect(mockLane.model_override, where).toBe(lane.model_override);
      expect(mockLane.effort_override, where).toBe(lane.effort_override);
      expect(Number(mockLane.handoff_context), where).toBe(lane.handoff_context);
      expect(mockLane.session_target, where).toBe(lane.session_target);
      expect(mockLane.session_spawn_strategy, where).toBe(lane.session_spawn_strategy);
    });
  });

  // Deliberate: the seed ships NO description. A description round-trips into
  // the project's committed kangentic.json (build-config serializes it once
  // set), so prefilled boilerplate would land in every user's repo and would
  // have to be cleared before they could write their own. The field is left
  // empty as an invitation.
  it('seeds no description on any column, leaving the field for the user', () => {
    for (const lane of seededLanes()) {
      expect(lane.description, `description of "${lane.name}" in ${SEED_FILE}`).toBeNull();
    }
  });

  it('ships no auto_command on any default column', () => {
    for (const lane of seededLanes()) {
      expect(lane.auto_command, `auto_command of "${lane.name}"`).toBeNull();
    }
  });

  it('wires Planning\'s plan exit to Executing in both tiers', () => {
    const seeded = seededLanes();
    const mock = mockLanes();

    const planning = seeded.find((lane) => lane.permission_mode === 'plan')!;
    const executing = seeded[seeded.indexOf(planning) + 1];
    expect(planning.plan_exit_target_id).toBe(executing.id);

    // The mock cannot know seeded UUIDs; it uses a sentinel its project-create
    // path resolves to the lane after Planning.
    const mockPlanning = mock.find((lane) => lane.permission_mode === 'plan')!;
    expect(mockPlanning.plan_exit_target_id).toBe('__executing__');
    for (const lane of mock) {
      if (lane === mockPlanning) continue;
      expect(lane.plan_exit_target_id, `plan_exit_target_id of mock "${lane.name}"`).toBeNull();
    }
  });

  it('uses only icons that resolve in the renderer icon registry', () => {
    for (const lane of seededLanes()) {
      expect(
        ICON_REGISTRY.has(lane.icon),
        `icon "${lane.icon}" of "${lane.name}" does not resolve in ICON_REGISTRY (swimlane-icons.tsx)`,
      ).toBe(true);
    }
  });
});
