/**
 * A swimlane role outside the SwimlaneRole union must never reach a consumer.
 *
 * Sentry DESKTOP-D: `swimlanes.role` is plain TEXT with no CHECK constraint, and roles
 * that left the union ('planning', 'running', 'backlog') genuinely shipped. Both role
 * icon maps in the renderer are two-key `Record<SwimlaneRole, ...>` lookups, so an
 * unknown role resolved to undefined - fatal in BoardManagerDialog's Icon field
 * (`<undefined />`, React error #130, a blanked board) and silent in `getUsedIcons`
 * (undefined into a `Set<string>`).
 *
 * Three layers are pinned here: the shared normalizer, the migration that repairs rows
 * already on disk, and the renderer helper that shares the hazard with the crash site.
 * The crash itself is a rendered assertion and lives in
 * tests/ui/board-manager-legacy-role.spec.ts.
 *
 * node:sqlite rather than better-sqlite3 on purpose: better-sqlite3 is compiled for
 * Electron's Node ABI, so every suite gated on it skips everywhere, CI included. This
 * suite skips only where node:sqlite itself is unavailable (built-in on Node 22.5+; CI
 * passes --experimental-sqlite via vitest execArgv).
 */

import { describe, it, expect, vi } from 'vitest';
import type DatabaseType from 'better-sqlite3';

// Hand applyBoardConfigToDb the in-memory DB built per-test, so the real (unmocked)
// SwimlaneRepository runs against it. Same shape as apply-config-column-delete.test.ts,
// but backed by node:sqlite so it actually runs rather than skipping on the ABI probe.
const hoisted = vi.hoisted(() => ({ currentDb: null as unknown }));
vi.mock('../../src/main/db/database', () => ({ getProjectDb: () => hoisted.currentDb }));

import { SWIMLANE_ROLES, normalizeSwimlaneRole } from '../../src/shared/types';
import { getUsedIcons } from '../../src/renderer/utils/swimlane-icons';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { SwimlaneRepository } from '../../src/main/db/repositories/swimlane-repository';
import { applyBoardConfigToDb } from '../../src/main/config/board-config/apply-config';
import { buildBoardConfigFromDb } from '../../src/main/config/board-config/build-config';
import type { BoardConfig, Swimlane, SwimlaneRole } from '../../src/shared/types';

type SqliteModule = typeof import('node:sqlite');
let sqlite: SqliteModule | null = null;
try {
  sqlite = await import('node:sqlite');
} catch {
  sqlite = null;
}

const describeWithSqlite = sqlite ? describe : describe.skip;

/**
 * Adapt node:sqlite's DatabaseSync to the slice of better-sqlite3's surface the
 * migrations use. Same shim as default-swimlanes-seed-parity.test.ts, including its
 * caveat: `transaction` is raw BEGIN/COMMIT and does not nest.
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

function makeSwimlane(overrides: Partial<Swimlane>): Swimlane {
  return {
    id: 'lane-1',
    name: 'Lane',
    description: null,
    role: null,
    position: 0,
    color: '#3b82f6',
    icon: null,
    is_archived: false,
    is_ghost: false,
    permission_mode: null,
    auto_spawn: true,
    auto_command: null,
    auto_command_mode: 'immediate',
    plan_exit_target_id: null,
    agent_override: null,
    model_override: null,
    effort_override: null,
    handoff_context: false,
    session_target: 'main',
    session_spawn_strategy: 'create_or_resume',
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('normalizeSwimlaneRole', () => {
  it('is exactly the two system roles', () => {
    // Pinned as literals on purpose. Every other assertion in this file compares the
    // migration's output against SWIMLANE_ROLES itself, so it holds whatever the array
    // contains. Dropping a role from the array would make the unconditional repair in
    // runProjectMigrations null that role in every project database on next open, and
    // this suite would stay green through it.
    expect([...SWIMLANE_ROLES]).toEqual(['todo', 'done']);
  });

  it('keeps every role in the union', () => {
    for (const role of SWIMLANE_ROLES) {
      expect(normalizeSwimlaneRole(role)).toBe(role);
    }
  });

  it.each([
    ['planning', 'a role removed when planning became a permission mode'],
    ['running', 'a role removed when Executing became a custom column'],
    ['backlog', 'a role renamed to todo before the backlog became its own view'],
    ['', 'an empty string, which the old `|| null` cast also caught'],
    ['TODO', 'the right role in the wrong case'],
  ])('drops %s (%s)', (value) => {
    expect(normalizeSwimlaneRole(value)).toBeNull();
  });

  it.each([[null], [undefined], [0], [{ role: 'todo' }], [['todo']]])(
    'drops the non-string %s',
    (value) => {
      expect(normalizeSwimlaneRole(value)).toBeNull();
    },
  );
});

describe('getUsedIcons', () => {
  it('resolves the role default icon name for a role in the union', () => {
    const used = getUsedIcons([makeSwimlane({ role: 'todo', icon: null })]);
    expect(used.has('layers')).toBe(true);
  });

  it('never puts undefined in the set for a role outside the union', () => {
    // Same two-key lookup as the crash site. Undefined here is silent rather than
    // fatal: it compares unequal to every real icon name, so the picker would mark
    // nothing as taken.
    const used = getUsedIcons([makeSwimlane({ role: 'planning' as SwimlaneRole, icon: null })]);
    expect([...used]).toEqual([]);
    expect(used.has(undefined as unknown as string)).toBe(false);
  });
});

describeWithSqlite('runProjectMigrations - legacy role repair', () => {
  function migrateWithRoles(roles: string[]): Array<string | null> {
    const database = new sqlite!.DatabaseSync(':memory:');
    try {
      const db = adaptDatabase(database);
      runProjectMigrations(db);

      // Stamp the legacy roles the way a real install carries them: written by an
      // older build, or applied later from a teammate's kangentic.json.
      const lanes = database
        .prepare('SELECT id FROM swimlanes ORDER BY position ASC')
        .all() as Array<{ id: string }>;
      expect(lanes.length).toBeGreaterThanOrEqual(roles.length);
      roles.forEach((role, index) => {
        database.prepare('UPDATE swimlanes SET role = ? WHERE id = ?').run(role, lanes[index].id);
      });

      // Re-running is what a real app restart does, and is also the idempotency check.
      runProjectMigrations(db);

      return roles.map(
        (_role, index) =>
          (database.prepare('SELECT role FROM swimlanes WHERE id = ?').get(lanes[index].id) as {
            role: string | null;
          }).role,
      );
    } finally {
      database.close();
    }
  }

  it('clears a role outside the union', () => {
    expect(migrateWithRoles(['planning', 'running'])).toEqual([null, null]);
  });

  it('still promotes backlog to todo rather than clearing it', () => {
    // The ordering guard. The catch-all must run AFTER the backlog remap: nulling
    // backlog instead would leave the board with no To Do role, and applyBoardConfigToDb's
    // hasTodo check would then prepend a second To Do column.
    expect(migrateWithRoles(['backlog'])).toEqual(['todo']);
  });

  it('leaves a valid role alone', () => {
    expect(migrateWithRoles([...SWIMLANE_ROLES])).toEqual([...SWIMLANE_ROLES]);
  });
});

describeWithSqlite('applyBoardConfigToDb - role arriving from kangentic.json', () => {
  /**
   * A config that mirrors every existing lane 1:1 (so the reconciler's ghost-or-delete
   * branch never fires - that branch nests a transaction, which the node:sqlite shim
   * cannot do) plus one brand-new column carrying the role under test. New id means the
   * create branch runs, which is the only path that writes `role`.
   */
  function applyWithNewColumnRole(role: string | null): {
    warnings: string[];
    created: Swimlane | undefined;
    /**
     * The role as it sits in SQLite, read around the repository on purpose. mapRow now
     * narrows, so asserting on `created.role` alone would pass whether or not
     * apply-config persisted the bad string - it would only prove the read path works.
     * What has to be pinned here is that nothing bad was WRITTEN, because update() has
     * no way to repair it afterwards.
     */
    storedRole: string | null;
  } {
    const database = new sqlite!.DatabaseSync(':memory:');
    try {
      const db = adaptDatabase(database);
      runProjectMigrations(db);
      hoisted.currentDb = db;
      const repository = new SwimlaneRepository(db);

      const config: BoardConfig = {
        version: 1,
        columns: [
          ...repository.list().map((lane) => ({
            id: lane.id,
            name: lane.name,
            role: lane.role ?? undefined,
            permissionMode: lane.permission_mode ?? undefined,
          })),
          { id: 'lane-from-teammate', name: 'Teammate Column', role: role as unknown as SwimlaneRole },
        ],
        actions: [],
        transitions: [],
      };
      // Done must stay last, and the reconciler enforces that by moving it - so the new
      // column lands before it either way.
      const { warnings } = applyBoardConfigToDb('project-1', config);
      const row = database
        .prepare('SELECT role FROM swimlanes WHERE id = ?')
        .get('lane-from-teammate') as { role: string | null } | undefined;
      return {
        warnings,
        created: repository.getById('lane-from-teammate'),
        storedRole: row?.role ?? null,
      };
    } finally {
      hoisted.currentDb = null;
      database.close();
    }
  }

  it('stores a role in the union as-is', () => {
    // 'todo' would collide with the seeded To Do lane, so 'done' is the valid case here.
    const { warnings, created, storedRole } = applyWithNewColumnRole('done');
    expect(storedRole).toBe('done');
    expect(created?.role).toBe('done');
    expect(warnings.filter((warning) => warning.includes('unknown role'))).toEqual([]);
  });

  it('never persists an out-of-union role, and warns', () => {
    // Without the normalization this writes the literal string into SQLite (no CHECK
    // constraint), where update() cannot repair it and the renderer then crashes on it.
    const { warnings, created, storedRole } = applyWithNewColumnRole('planning');
    expect(created).toBeDefined();
    expect(storedRole).toBeNull();
    expect(warnings).toContain(
      'Column "Teammate Column" has an unknown role "planning". Treated as a custom column.',
    );
  });

  it('treats an explicit null role as a custom column without warning', () => {
    // JSON.parse turns `"role": null` in a hand-edited kangentic.json into a real null,
    // which BoardConfigColumn's type does not admit. A column with no role is already a
    // custom column, so warning here would report a legacy value that was never there.
    const { warnings, created, storedRole } = applyWithNewColumnRole(null);
    expect(created).toBeDefined();
    expect(storedRole).toBeNull();
    expect(warnings.filter((warning) => warning.includes('unknown role'))).toEqual([]);
  });

  it('still promotes the legacy backlog role to todo', () => {
    // The remap runs before the catch-all, mirroring the migration's ordering.
    expect(applyWithNewColumnRole('backlog').storedRole).toBe('todo');
  });
});

describeWithSqlite('buildBoardConfigFromDb - team propagation of a bad role', () => {
  /**
   * The write-back is how one broken install infects a whole team: the DB serializes to a
   * COMMITTED kangentic.json, which every teammate then applies. This is the only tier that
   * can cover it - `BoardConfigManager.writeBack()` returns early when `isEphemeral`, so a
   * /preview never writes the file at all.
   */
  it('omits the role of a column whose stored role is outside the union', () => {
    const database = new sqlite!.DatabaseSync(':memory:');
    try {
      const db = adaptDatabase(database);
      runProjectMigrations(db);
      hoisted.currentDb = db;

      // Write the bad role AFTER migrations, the way a stale kangentic.json or an older
      // build leaves one behind - running the migration again here would just repair it.
      database.prepare("UPDATE swimlanes SET role = 'planning' WHERE name = 'Planning'").run();

      const config = buildBoardConfigFromDb({
        projectId: 'project-1',
        existingTeamConfig: null,
        fingerprint: 'test',
      });

      const planning = config.columns.find((column) => column.name === 'Planning');
      expect(planning).toBeDefined();
      // `build-config` writes `if (lane.role) column.role = lane.role`, so the guarantee
      // rides entirely on mapRow having narrowed it first.
      expect(planning?.role).toBeUndefined();
      expect(JSON.stringify(config)).not.toContain('planning');

      // The real roles still round-trip, so this is not passing by emitting nothing.
      expect(config.columns.find((column) => column.name === 'To Do')?.role).toBe('todo');
      expect(config.columns.find((column) => column.name === 'Done')?.role).toBe('done');
    } finally {
      hoisted.currentDb = null;
      database.close();
    }
  });
});
