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
 * The DB + repositories are mocked so this stays a pure unit test of the
 * build/apply round-trip with no database involved (same pattern as
 * task-move-isolation-switch.test.ts).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Swimlane, BoardColumnConfig, BoardConfig } from '../../src/shared/types';
import { readInterfaceFieldNames } from './helpers/shared-type-source';

// ---------------------------------------------------------------------------
// Shared mock state (hoisted so the mocked repository classes can read/record).
// ---------------------------------------------------------------------------
const hoisted = vi.hoisted(() => ({
  lanes: [] as unknown[],
  createCalls: [] as Array<Record<string, unknown>>,
  updateCalls: [] as Array<Record<string, unknown>>,
  /** Whole-column automation writes, keyed by swimlane id. */
  automationWrites: [] as Array<{ swimlaneId: string; rows: unknown[] }>,
}));

vi.mock('../../src/main/db/database', () => ({
  // A fake db: transaction(fn) returns a callable that runs fn synchronously,
  // with the `.immediate` variant writeTransaction calls. Inline rather than the
  // shared helper, because a vi.mock factory runs before imports.
  getProjectDb: vi.fn(() => ({
    transaction: (fn: (...a: unknown[]) => unknown) => {
      const run = (...a: unknown[]) => fn(...a);
      return Object.assign(run, { immediate: run });
    },
  })),
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

vi.mock('../../src/main/db/repositories/automation-repository', () => ({
  AutomationRepository: class {
    listAll = vi.fn(() => []);
    listForColumn = vi.fn(() => []);
    getForTrigger = vi.fn(() => []);
    replaceForColumn = vi.fn((swimlaneId: string, rows: unknown[]) => {
      hoisted.automationWrites.push({ swimlaneId, rows });
      return rows;
    });
    deleteForColumn = vi.fn();
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
// THE GUARD: classify every swimlane field. Update this map AND wire the field
// into build-config.ts + apply-config.ts when adding a team-shared field.
//
// The `Record<keyof Swimlane, ...>` annotation is kept for the editor, but the
// load-bearing check is the runtime test below. tsconfig.json includes only
// `src/**` and `packages/protocol/src/**`, so `npm run typecheck` never reads
// this file and the annotation alone would fail nowhere in CI.
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
  // RETIRED, and 'db-only' for a specific reason rather than to quiet this
  // guard. The column's message is a `send_message` automation now, and it is
  // still team-shared: it round-trips through `columns[].automations`, pinned by
  // board-config-automations-roundtrip.test.ts. What is left on the swimlane row
  // is a legacy column nothing reads and nothing writes from the config, so
  // serializing it would put the message in two places that could disagree.
  auto_command: 'db-only',
  auto_command_mode: 'db-only',
  plan_exit_target_id: 'team',
  agent_override: 'team',
  model_override: 'team',
  effort_override: 'team',
  handoff_context: 'team',
  session_target: 'team',
  session_spawn_strategy: 'team',
  plan_approval: 'team',
  max_agents: 'team',
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
  { field: 'agent_override', configKey: 'agentOverride', dbValue: 'codex', configValue: 'codex' },
  { field: 'model_override', configKey: 'modelOverride', dbValue: 'opus', configValue: 'opus' },
  { field: 'effort_override', configKey: 'effortOverride', dbValue: 'high', configValue: 'high' },
  { field: 'handoff_context', configKey: 'handoffContext', dbValue: true, configValue: true },
  { field: 'session_target', configKey: 'sessionTarget', dbValue: 'isolated', configValue: 'isolated' },
  { field: 'session_spawn_strategy', configKey: 'sessionSpawnStrategy', dbValue: 'always_spawn_new', configValue: 'always_spawn_new' },
  { field: 'plan_approval', configKey: 'planApproval', dbValue: 'automatic', configValue: 'automatic' },
  { field: 'max_agents', configKey: 'maxAgents', dbValue: 1, configValue: 1 },
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
    auto_command_mode: 'immediate',
    plan_exit_target_id: null,
    agent_override: null,
    model_override: null,
    effort_override: null,
    handoff_context: false,
    session_target: 'main',
    session_spawn_strategy: 'create_or_resume',
    plan_approval: 'manual',
    max_agents: null,
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

  it('classifies exactly the fields the Swimlane interface declares', () => {
    // The runtime half of THE GUARD above. The `Record<keyof Swimlane, ...>`
    // annotation cannot do this job in CI: tsconfig.json includes only `src/**`
    // and `packages/protocol/src/**`, so npm run typecheck never reads this
    // file. Without this test a new swimlane field could ship unclassified and
    // never round-trip to kangentic.json, which is the bug the rule exists for.
    const declared = readInterfaceFieldNames('Swimlane');
    const classified = Object.keys(SWIMLANE_FIELD_SHARING);

    const unclassified = declared.filter((field) => !classified.includes(field));
    expect(
      unclassified,
      'These Swimlane fields have no entry in SWIMLANE_FIELD_SHARING. Classify each one '
      + "'team' (and add a ROUNDTRIP_CASES entry plus build-config/apply-config wiring) or "
      + `'db-only':\n${unclassified.map((field) => `  ${field}`).join('\n')}`,
    ).toEqual([]);

    const stale = classified.filter((field) => !declared.includes(field));
    expect(
      stale,
      `SWIMLANE_FIELD_SHARING classifies fields the Swimlane interface no longer declares - `
      + `remove them:\n${stale.map((field) => `  ${field}`).join('\n')}`,
    ).toEqual([]);
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

  describe('maxAgents serialization', () => {
    const columnOf = (config: BoardConfig, laneId: string): BoardColumnConfig | undefined => (
      config.columns.find((candidate) => candidate.id === laneId)
    );

    // No limit is the default, and build omits a default so an unlimited board
    // stays byte-identical. Apply reads the absent key as no limit.
    //
    // Red trigger: write `column.maxAgents = lane.max_agents` unconditionally and
    // the key appears as null.
    it('omits maxAgents for a column with no limit', () => {
      hoisted.lanes = [makeSwimlane({ id: 'lane-review', name: 'Review', max_agents: null })];

      const config = buildBoardConfigFromDb({ projectId: 'p', existingTeamConfig: null, fingerprint: 'fp' });

      expect(columnOf(config, 'lane-review')).not.toHaveProperty('maxAgents');
    });

    it('writes the limit of a column that has one', () => {
      hoisted.lanes = [makeSwimlane({ id: 'lane-review', name: 'Review', max_agents: 2 })];

      const config = buildBoardConfigFromDb({ projectId: 'p', existingTeamConfig: null, fingerprint: 'fp' });

      expect(columnOf(config, 'lane-review')?.maxAgents).toBe(2);
    });

    // To Do and Done run no agent, so a limit on one has nothing to share.
    //
    // Red trigger: drop the `lane.role !== 'todo' && lane.role !== 'done'` clause
    // in build-config.ts and both keys appear.
    it.each(['todo', 'done'] as const)('omits maxAgents for the %s column even when the row holds one', (role) => {
      hoisted.lanes = [makeSwimlane({ id: `lane-${role}`, name: role, role, max_agents: 1 })];

      const config = buildBoardConfigFromDb({ projectId: 'p', existingTeamConfig: null, fingerprint: 'fp' });

      expect(columnOf(config, `lane-${role}`)).toBeDefined();
      expect(columnOf(config, `lane-${role}`)).not.toHaveProperty('maxAgents');
    });
  });

  // ---------------------------------------------------------------------------
  // Config-only keys (no DB representation) must survive a write-back.
  //
  // buildBoardConfigFromDb rebuilds kangentic.json wholesale from the database,
  // so a top-level key the DB knows nothing about is DESTROYED unless it is
  // explicitly carried across from the existing team config. That preservation
  // block was hand-maintained with no test, which is exactly how a config-only
  // key gets silently wiped by the next column edit.
  // ---------------------------------------------------------------------------
  describe('config-only key preservation', () => {
    it('carries `profiles` across a rebuild, so editing a column does not wipe Board Profiles', () => {
      // Red trigger: delete the `profiles` preservation line in build-config.ts.
      hoisted.lanes = [makeSwimlane({ id: 'lane-executing', name: 'Executing' })];

      const existingTeamConfig: BoardConfig = {
        version: 1,
        columns: [],
        actions: [],
        transitions: [],
        profiles: [{
          id: 'profile-frugal',
          name: 'Frugal',
          columns: { 'lane-executing': { modelOverride: 'claude-sonnet-5', effortOverride: 'high' } },
        }],
      };

      const rebuilt = buildBoardConfigFromDb({ projectId: 'p', existingTeamConfig, fingerprint: 'fp' });

      expect(
        rebuilt.profiles,
        'build-config.ts dropped the `profiles` key on rebuild - every Board Profile would be '
        + 'destroyed the first time anyone edits a column',
      ).toEqual(existingTeamConfig.profiles);
    });

    it('carries `shortcuts` and `defaultBaseBranch` across a rebuild', () => {
      hoisted.lanes = [makeSwimlane()];

      const existingTeamConfig: BoardConfig = {
        version: 1,
        columns: [],
        actions: [],
        transitions: [],
        shortcuts: [{ id: 'shortcut-1', label: 'Open in VS Code', command: 'code "{{cwd}}"' }],
        defaultBaseBranch: 'develop',
      };

      const rebuilt = buildBoardConfigFromDb({ projectId: 'p', existingTeamConfig, fingerprint: 'fp' });

      expect(rebuilt.shortcuts).toEqual(existingTeamConfig.shortcuts);
      expect(rebuilt.defaultBaseBranch).toBe('develop');
    });

    it('omits `profiles` entirely when the board has none, so day one is unchanged', () => {
      hoisted.lanes = [makeSwimlane()];

      const rebuilt = buildBoardConfigFromDb({ projectId: 'p', existingTeamConfig: null, fingerprint: 'fp' });

      expect(rebuilt.profiles).toBeUndefined();
    });
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

  it('stores a hand-written model exactly as written, whatever the agent', () => {
    // The file does not know which agent a column runs, so it never rewrites a
    // model: "Gemini 2.5" must not become `claude-gemini-2-5`. A friendly Claude
    // name ("Opus") is converted where it is used, by the Claude adapter at
    // spawn (claude-command-builder model tests).
    for (const written of ['Opus', 'Opus 5.5', 'Gemini 2.5', 'GPT-5.5', 'claude-opus-5-5']) {
      hoisted.lanes = [
        makeSwimlane({ id: 'lane-todo', name: 'To Do', role: 'todo' }),
        makeSwimlane({ id: 'lane-review', name: 'Review' }),
        makeSwimlane({ id: 'lane-done', name: 'Done', role: 'done', is_archived: true }),
      ];
      applyBoardConfigToDb('p', makeConfig({ id: 'lane-review', name: 'Review', modelOverride: written }));
      const updated = hoisted.updateCalls.filter((call) => call.id === 'lane-review').at(-1);
      expect((updated as Record<string, unknown>).model_override, `"${written}"`).toBe(written);
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

  it('update turns plan approval back to Manual when the config omits the key', () => {
    // The deliberate exception to the description rule above. Build omits
    // `planApproval` at its default, so a teammate switching a column back to
    // Manual removes the key; falling back to the receiving machine's value would
    // keep approving plans there.
    //
    // Red trigger: change the update path to `columnConfig.planApproval ?? existing.plan_approval`.
    hoisted.lanes = [
      makeSwimlane({ id: 'lane-todo', name: 'To Do', role: 'todo' }),
      makeSwimlane({ id: 'lane-review', name: 'Review', plan_approval: 'automatic' }),
      makeSwimlane({ id: 'lane-done', name: 'Done', role: 'done', is_archived: true }),
    ];

    applyBoardConfigToDb('p', makeConfig({ id: 'lane-review', name: 'Review' }));

    const updated = hoisted.updateCalls.find((call) => call.id === 'lane-review');
    expect((updated as Record<string, unknown>).plan_approval).toBe('manual');
  });

  it('applies an absent maxAgents as no limit, so a teammate turning it off reaches this machine', () => {
    // No limit is what build-config omits. Red trigger: fall back to `existing.max_agents`.
    hoisted.lanes = [
      makeSwimlane({ id: 'lane-todo', name: 'To Do', role: 'todo' }),
      makeSwimlane({ id: 'lane-review', name: 'Review', max_agents: 1 }),
      makeSwimlane({ id: 'lane-done', name: 'Done', role: 'done', is_archived: true }),
    ];

    applyBoardConfigToDb('p', makeConfig({ id: 'lane-review', name: 'Review' }));

    const updated = hoisted.updateCalls.find((call) => call.id === 'lane-review');
    expect((updated as Record<string, unknown>).max_agents).toBeNull();
  });

  it.each([0, -1, 'one'])('reads a hand-edited maxAgents of %s as no limit, which cannot hold a column forever', (value) => {
    hoisted.lanes = [
      makeSwimlane({ id: 'lane-todo', name: 'To Do', role: 'todo' }),
      makeSwimlane({ id: 'lane-review', name: 'Review' }),
      makeSwimlane({ id: 'lane-done', name: 'Done', role: 'done', is_archived: true }),
    ];

    applyBoardConfigToDb('p', makeConfig({ id: 'lane-review', name: 'Review', maxAgents: value as number }));

    const updated = hoisted.updateCalls.find((call) => call.id === 'lane-review');
    expect((updated as Record<string, unknown>).max_agents).toBeNull();
  });

  // The existing lanes the apply cases below reconcile against.
  function seedLanes(): void {
    hoisted.lanes = [
      makeSwimlane({ id: 'lane-todo', name: 'To Do', role: 'todo' }),
      makeSwimlane({ id: 'lane-review', name: 'Review' }),
      makeSwimlane({ id: 'lane-done', name: 'Done', role: 'done', is_archived: true }),
    ];
  }

  const appliedLimit = (laneId: string): unknown => (
    (hoisted.updateCalls.find((call) => call.id === laneId) as Record<string, unknown> | undefined)?.max_agents
  );

  // A fractional limit is a whole number of agents in practice. Flooring keeps
  // the intent of "about one" rather than discarding the limit.
  //
  // Red trigger: drop the Math.floor in apply-config.ts and 1.5 reaches the DB.
  it('floors a fractional maxAgents, in both the update and the create path', () => {
    seedLanes();
    applyBoardConfigToDb('p', makeConfig({ id: 'lane-review', name: 'Review', maxAgents: 1.5 }));
    expect(appliedLimit('lane-review')).toBe(1);

    // A column with no id is new: the lanes hold only To Do and Done.
    hoisted.lanes = [
      makeSwimlane({ id: 'lane-todo', name: 'To Do', role: 'todo' }),
      makeSwimlane({ id: 'lane-done', name: 'Done', role: 'done', is_archived: true }),
    ];
    applyBoardConfigToDb('p', makeConfig({ name: 'Brand New', maxAgents: 2.9 }));
    const created = hoisted.createCalls.find((call) => call.name === 'Brand New');
    expect((created as Record<string, unknown>).max_agents).toBe(2);
  });

  // `true` is a number-looking limit to a loose reader. Reading it as 1 would
  // quietly cap a column the file never limited.
  //
  // Red trigger: replace the `typeof ... === 'number'` check with a truthiness
  // check and `true` reads as a limit of 1.
  it('reads a boolean maxAgents as no limit', () => {
    seedLanes();
    applyBoardConfigToDb('p', makeConfig({ id: 'lane-review', name: 'Review', maxAgents: true as unknown as number }));

    expect(appliedLimit('lane-review')).toBeNull();
  });

  // Red trigger: drop the `!isTodo && !isDone` clause in apply-config.ts and
  // both columns take the limit.
  it('ignores a maxAgents on the To Do and Done columns', () => {
    seedLanes();
    applyBoardConfigToDb('p', {
      version: 1,
      columns: [
        { id: 'lane-todo', name: 'To Do', role: 'todo', maxAgents: 1 },
        { id: 'lane-review', name: 'Review' },
        { id: 'lane-done', name: 'Done', role: 'done', maxAgents: 1 },
      ],
      actions: [],
      transitions: [],
    });

    expect(appliedLimit('lane-todo')).toBeNull();
    expect(appliedLimit('lane-done')).toBeNull();
  });

  // The file arrives as text. Every case above hands apply a typed object, which
  // a JSON.parse of a hand-edited file can differ from: a number, a float, a
  // boolean and a string are all spelled out here the way a teammate would.
  it('reads the limits of a file-shaped JSON string the way the typed cases do', () => {
    hoisted.lanes = [
      makeSwimlane({ id: 'lane-todo', name: 'To Do', role: 'todo' }),
      makeSwimlane({ id: 'lane-review', name: 'Review' }),
      makeSwimlane({ id: 'lane-gate', name: 'Gate' }),
      makeSwimlane({ id: 'lane-flag', name: 'Flag' }),
      makeSwimlane({ id: 'lane-text', name: 'Text' }),
      makeSwimlane({ id: 'lane-done', name: 'Done', role: 'done', is_archived: true }),
    ];
    const fileText = `{
      "version": 1,
      "columns": [
        { "id": "lane-todo", "name": "To Do", "role": "todo", "maxAgents": 1 },
        { "id": "lane-review", "name": "Review", "maxAgents": 2 },
        { "id": "lane-gate", "name": "Gate", "maxAgents": 1.5 },
        { "id": "lane-flag", "name": "Flag", "maxAgents": true },
        { "id": "lane-text", "name": "Text", "maxAgents": "3" },
        { "id": "lane-done", "name": "Done", "role": "done", "maxAgents": 1 }
      ],
      "actions": [],
      "transitions": []
    }`;

    applyBoardConfigToDb('p', JSON.parse(fileText) as BoardConfig);

    expect(appliedLimit('lane-review')).toBe(2);
    expect(appliedLimit('lane-gate')).toBe(1);
    expect(appliedLimit('lane-flag')).toBeNull();
    expect(appliedLimit('lane-text')).toBeNull();
    expect(appliedLimit('lane-todo')).toBeNull();
    expect(appliedLimit('lane-done')).toBeNull();
  });
});
