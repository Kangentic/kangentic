/**
 * Board-config parity guard (see .claude/rules/board-config-parity.md).
 *
 * Team-shared board state syncs through a CURATED `BoardColumnConfig`:
 * `build-config.ts` writes DB->kangentic.json and `apply-config.ts` applies it
 * back. A swimlane field that exists in the DB/UI but is NOT wired into that
 * round-trip persists only to the per-machine project DB and never reaches
 * teammates - which is exactly how `session_target` / `session_spawn_strategy`
 * silently failed to ship alongside their team-shared partner `auto_command`.
 *
 * This test makes that class of gap impossible to add silently:
 *   1. COMPILE-TIME completeness - `Record<keyof Swimlane, FieldSharing>` fails
 *      `npm run typecheck` the moment a migration adds a swimlane field without
 *      classifying it team-shared vs db-only. This is the self-maintaining core.
 *   2. COVERAGE - every 'team' field is exercised by a round-trip case (or listed
 *      as structural), so a newly-classified team field forces a round-trip case.
 *   3. RUNTIME round-trip - build emits each team field, and apply threads each
 *      back into the swimlane create/update inputs. Catches "added to the type
 *      but forgot build or apply."
 *
 * better-sqlite3 cannot load under vitest, so the DB + repositories are mocked
 * (same pattern as task-move-isolation-switch.test.ts).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Swimlane, BoardColumnConfig, BoardConfig } from '../../src/shared/types';

// ---------------------------------------------------------------------------
// Shared mock state (hoisted so the mocked repository classes can read/record).
// ---------------------------------------------------------------------------
const hoisted = vi.hoisted(() => ({
  lanes: [] as unknown[],
  createCalls: [] as Array<Record<string, unknown>>,
  updateCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../src/main/db/database', () => ({
  // A fake db: transaction(fn) returns a callable that runs fn synchronously.
  getProjectDb: vi.fn(() => ({ transaction: (fn: (...a: unknown[]) => unknown) => (...a: unknown[]) => fn(...a) })),
}));

vi.mock('../../src/main/db/repositories/swimlane-repository', () => ({
  SwimlaneRepository: class {
    list = vi.fn(() => hoisted.lanes);
    create = vi.fn((input: Record<string, unknown>) => { hoisted.createCalls.push(input); return input; });
    update = vi.fn((input: Record<string, unknown>) => { hoisted.updateCalls.push(input); return input; });
    delete = vi.fn();
    setGhost = vi.fn();
    deleteEmptyGhosts = vi.fn(() => 0);
    reorder = vi.fn();
  },
}));

vi.mock('../../src/main/db/repositories/action-repository', () => ({
  ActionRepository: class {
    list = vi.fn(() => []);
    listTransitions = vi.fn(() => []);
    create = vi.fn();
    delete = vi.fn();
    createTransition = vi.fn();
    deleteTransitionsFrom = vi.fn();
    clearTransitions = vi.fn();
  },
}));

import { buildBoardConfigFromDb } from '../../src/main/config/board-config/build-config';
import { applyBoardConfigToDb } from '../../src/main/config/board-config/apply-config';

// ---------------------------------------------------------------------------
// THE GUARD: classify every swimlane field. `Record<keyof Swimlane>` makes tsc
// fail when a field is added without a decision. Update this map AND wire the
// field into build-config.ts + apply-config.ts when adding a team-shared field.
// ---------------------------------------------------------------------------
type FieldSharing = 'team' | 'db-only';
const SWIMLANE_FIELD_SHARING: Record<keyof Swimlane, FieldSharing> = {
  // Team-shared: must round-trip through BoardColumnConfig (build + apply).
  name: 'team',
  description: 'team',
  role: 'team',
  color: 'team',
  icon: 'team',
  is_archived: 'team',
  permission_mode: 'team',
  auto_spawn: 'team',
  auto_command: 'team',
  plan_exit_target_id: 'team',
  agent_override: 'team',
  model_override: 'team',
  effort_override: 'team',
  handoff_context: 'team',
  session_target: 'team',
  session_spawn_strategy: 'team',
  // DB-only: identity / ordering / runtime state / timestamp - never team config.
  id: 'db-only',
  position: 'db-only',
  is_ghost: 'db-only',
  created_at: 'db-only',
};

/**
 * Simple value-passthrough team fields: each maps a swimlane field to its
 * BoardColumnConfig key, a non-default DB value, and the value build should
 * emit. The apply leg reuses `field` (apply input keys are snake_case = the
 * swimlane field name) and `dbValue`.
 */
const ROUNDTRIP_CASES: Array<{ field: keyof Swimlane; configKey: keyof BoardColumnConfig; dbValue: unknown; configValue: unknown }> = [
  { field: 'description', configKey: 'description', dbValue: 'Review happens here', configValue: 'Review happens here' },
  { field: 'color', configKey: 'color', dbValue: '#abcdef', configValue: '#abcdef' },
  { field: 'icon', configKey: 'icon', dbValue: 'flask-conical', configValue: 'flask-conical' },
  { field: 'is_archived', configKey: 'archived', dbValue: true, configValue: true },
  { field: 'permission_mode', configKey: 'permissionMode', dbValue: 'plan', configValue: 'plan' },
  { field: 'auto_spawn', configKey: 'autoSpawn', dbValue: true, configValue: true },
  { field: 'auto_command', configKey: 'autoCommand', dbValue: '/code-review', configValue: '/code-review' },
  { field: 'agent_override', configKey: 'agentOverride', dbValue: 'codex', configValue: 'codex' },
  { field: 'model_override', configKey: 'modelOverride', dbValue: 'opus', configValue: 'opus' },
  { field: 'effort_override', configKey: 'effortOverride', dbValue: 'high', configValue: 'high' },
  { field: 'handoff_context', configKey: 'handoffContext', dbValue: true, configValue: true },
  { field: 'session_target', configKey: 'sessionTarget', dbValue: 'isolated', configValue: 'isolated' },
  { field: 'session_spawn_strategy', configKey: 'sessionSpawnStrategy', dbValue: 'always_spawn_new', configValue: 'always_spawn_new' },
];

/**
 * Team fields handled structurally rather than as a value passthrough:
 *   name - always emitted; role - column identity (conditional);
 *   plan_exit_target_id - emitted as `planExitTarget` resolved BY NAME.
 * Listed so the coverage test below stays exhaustive.
 */
const STRUCTURAL_TEAM_FIELDS: Array<keyof Swimlane> = ['name', 'role', 'plan_exit_target_id'];

function makeSwimlane(overrides: Partial<Swimlane> = {}): Swimlane {
  return {
    id: 'lane-custom',
    name: 'Review',
    description: null,
    role: null,
    position: 1,
    color: '#3b82f6',
    icon: null,
    is_archived: false,
    is_ghost: false,
    permission_mode: null,
    auto_spawn: false,
    auto_command: null,
    plan_exit_target_id: null,
    agent_override: null,
    model_override: null,
    effort_override: null,
    handoff_context: false,
    session_target: 'main',
    session_spawn_strategy: 'create_or_resume',
    created_at: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.lanes = [];
  hoisted.createCalls = [];
  hoisted.updateCalls = [];
});

describe('board-config parity: coverage', () => {
  it('every team-shared swimlane field is exercised by a round-trip case or marked structural', () => {
    const covered = new Set<keyof Swimlane>([
      ...ROUNDTRIP_CASES.map((entry) => entry.field),
      ...STRUCTURAL_TEAM_FIELDS,
    ]);
    const teamFields = (Object.keys(SWIMLANE_FIELD_SHARING) as Array<keyof Swimlane>)
      .filter((field) => SWIMLANE_FIELD_SHARING[field] === 'team');

    for (const field of teamFields) {
      expect(
        covered.has(field),
        `Swimlane field '${field}' is team-shared but has no round-trip case. Add it to `
        + `ROUNDTRIP_CASES (and wire it into build-config.ts + apply-config.ts) or to `
        + `STRUCTURAL_TEAM_FIELDS if it needs special handling.`,
      ).toBe(true);
    }
  });
});

describe('board-config parity: build (DB -> kangentic.json)', () => {
  it('serializes every team-shared value field onto BoardColumnConfig', () => {
    const laneOverrides: Partial<Swimlane> = {};
    for (const entry of ROUNDTRIP_CASES) {
      (laneOverrides as Record<string, unknown>)[entry.field] = entry.dbValue;
    }
    hoisted.lanes = [makeSwimlane(laneOverrides)];

    const config = buildBoardConfigFromDb({ projectId: 'p', existingTeamConfig: null, fingerprint: 'fp' });
    const column = config.columns.find((candidate) => candidate.id === 'lane-custom');
    expect(column).toBeDefined();

    for (const entry of ROUNDTRIP_CASES) {
      expect(
        (column as Record<string, unknown>)[entry.configKey],
        `build-config.ts does not serialize '${entry.field}' to column.${String(entry.configKey)}`,
      ).toBe(entry.configValue);
    }
  });
});

describe('board-config parity: apply (kangentic.json -> DB)', () => {
  function makeConfig(reviewColumn: BoardColumnConfig): BoardConfig {
    return {
      version: 1,
      columns: [
        { id: 'lane-todo', name: 'To Do', role: 'todo' },
        reviewColumn,
        { id: 'lane-done', name: 'Done', role: 'done' },
      ],
      actions: [],
      transitions: [],
    };
  }

  function reviewColumnConfig(extra: Partial<BoardColumnConfig>): BoardColumnConfig {
    const base: BoardColumnConfig = { name: 'Review' };
    for (const entry of ROUNDTRIP_CASES) {
      (base as Record<string, unknown>)[entry.configKey] = entry.configValue;
    }
    return { ...base, ...extra };
  }

  it('threads every team-shared value field into the create input for a new column', () => {
    hoisted.lanes = [
      makeSwimlane({ id: 'lane-todo', name: 'To Do', role: 'todo' }),
      makeSwimlane({ id: 'lane-done', name: 'Done', role: 'done', is_archived: true }),
    ];

    // The Review column has no id -> create path.
    applyBoardConfigToDb('p', makeConfig(reviewColumnConfig({})));

    const created = hoisted.createCalls.find((call) => call.name === 'Review');
    expect(created, 'apply-config.ts did not create the new Review column').toBeDefined();
    for (const entry of ROUNDTRIP_CASES) {
      expect(
        (created as Record<string, unknown>)[entry.field],
        `apply-config.ts create() does not thread '${entry.field}'`,
      ).toBe(entry.dbValue);
    }
  });

  it('threads every team-shared value field into the update input for an existing column', () => {
    hoisted.lanes = [
      makeSwimlane({ id: 'lane-todo', name: 'To Do', role: 'todo' }),
      makeSwimlane({ id: 'lane-review', name: 'Review' }),
      makeSwimlane({ id: 'lane-done', name: 'Done', role: 'done', is_archived: true }),
    ];

    applyBoardConfigToDb('p', makeConfig(reviewColumnConfig({ id: 'lane-review' })));

    const updated = hoisted.updateCalls.find((call) => call.id === 'lane-review');
    expect(updated, 'apply-config.ts did not update the existing Review column').toBeDefined();
    for (const entry of ROUNDTRIP_CASES) {
      expect(
        (updated as Record<string, unknown>)[entry.field],
        `apply-config.ts update() does not thread '${entry.field}'`,
      ).toBe(entry.dbValue);
    }
  });

  it('update preserves existing description when config omits the description key', () => {
    // Build-config omits the description key entirely when lane.description is
    // null/falsy (the `if (lane.description)` guard).  When apply-config processes
    // a config that has no description key, the update input must fall back to
    // `existing.description` so the receiving machine's existing description is not
    // silently cleared.
    //
    // Red trigger: change `columnConfig.description ?? existing.description` to
    // `columnConfig.description ?? null` in apply-config.ts - the update call then
    // gets `description: null` and this assertion fails.
    hoisted.lanes = [
      makeSwimlane({ id: 'lane-todo', name: 'To Do', role: 'todo' }),
      makeSwimlane({ id: 'lane-review', name: 'Review', description: 'Pre-existing description text' }),
      makeSwimlane({ id: 'lane-done', name: 'Done', role: 'done', is_archived: true }),
    ];

    // Incoming config knows lane-review by id but carries no description key,
    // matching what build-config produces when the building machine had no description.
    applyBoardConfigToDb('p', makeConfig({ id: 'lane-review', name: 'Review' }));

    const updated = hoisted.updateCalls.find((call) => call.id === 'lane-review');
    expect(updated, 'apply-config.ts did not call update for the existing Review column').toBeDefined();
    expect(
      (updated as Record<string, unknown>).description,
      'apply-config.ts must fall back to existing.description when config omits the description key',
    ).toBe('Pre-existing description text');
  });
});
