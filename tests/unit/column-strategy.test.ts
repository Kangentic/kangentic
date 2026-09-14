import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  resolveColumnStrategy,
  findTaskProfile,
  resolveEffectiveAutoCommand,
  resolveColumnMessage,
  applyProfileToLane,
} from '../../src/main/transition-engine/column-strategy';
import type { BoardProfile, BoardProfileEntry, Swimlane } from '../../src/shared/types';
import type { LaneStrategyFields } from '../../src/main/transition-engine/column-strategy';

/** A base column that pins a full strategy, so "inherit" and "clear" are distinguishable. */
function makeLane(overrides: Partial<LaneStrategyFields> = {}): LaneStrategyFields {
  return {
    id: 'lane-executing',
    agent_override: 'claude',
    model_override: 'claude-opus-5',
    effort_override: 'high',
    permission_mode: 'auto',
    auto_spawn: true,
    handoff_context: true,
    session_target: 'main',
    session_spawn_strategy: 'create_or_resume',
    plan_exit_target_id: 'lane-review',
    ...overrides,
  };
}

function makeProfile(columns: BoardProfile['columns']): BoardProfile {
  return { id: 'profile-frugal', name: 'Frugal', columns };
}

describe('resolveColumnStrategy', () => {
  describe('no profile - behavior must be byte-identical to pre-profile Kangentic', () => {
    it('returns the lane values verbatim when the profile is null', () => {
      const lane = makeLane();
      expect(resolveColumnStrategy({ lane, profile: null })).toEqual({
        agent_override: 'claude',
        model_override: 'claude-opus-5',
        effort_override: 'high',
        permission_mode: 'auto',
        auto_spawn: true,
        handoff_context: true,
        session_target: 'main',
        session_spawn_strategy: 'create_or_resume',
        plan_exit_target_id: 'lane-review',
      });
    });

    it('returns lane values verbatim when the profile has no entry for this column', () => {
      const lane = makeLane();
      const profile = makeProfile({ 'lane-planning': { modelOverride: 'claude-fable-5' } });
      const resolved = resolveColumnStrategy({ lane, profile });
      expect(resolved.model_override).toBe('claude-opus-5');
      expect(resolved.effort_override).toBe('high');
    });

    it('falls back to safe defaults when there is no lane at all', () => {
      const resolved = resolveColumnStrategy({ lane: null, profile: makeProfile({}) });
      expect(resolved).toEqual({
        agent_override: null,
        model_override: null,
        effort_override: null,
        permission_mode: null,
        auto_spawn: false,
        handoff_context: false,
        session_target: 'main',
        session_spawn_strategy: 'create_or_resume',
        plan_exit_target_id: null,
      });
    });
  });

  describe('sparse semantics - the three states', () => {
    it('a present key with a value overrides the base column', () => {
      const lane = makeLane();
      const profile = makeProfile({ 'lane-executing': { modelOverride: 'claude-sonnet-5', effortOverride: 'medium' } });
      const resolved = resolveColumnStrategy({ lane, profile });
      expect(resolved.model_override).toBe('claude-sonnet-5');
      expect(resolved.effort_override).toBe('medium');
    });

    it('an absent key inherits the base column', () => {
      const lane = makeLane();
      const profile = makeProfile({ 'lane-executing': { modelOverride: 'claude-sonnet-5' } });
      const resolved = resolveColumnStrategy({ lane, profile });
      // effortOverride was never mentioned by the profile.
      expect(resolved.effort_override).toBe('high');
      expect(resolved.agent_override).toBe('claude');
    });

    // RED-GREEN GUARD: this is the case a `??`-based resolver silently gets wrong.
    // Rewrite resolveColumnStrategy as `entry.modelOverride ?? lane.model_override`
    // and this test fails while every other test here still passes.
    it('a present key set to null CLEARS the base column pin to the agent default', () => {
      const lane = makeLane();
      const profile = makeProfile({
        'lane-executing': { modelOverride: null, effortOverride: null, agentOverride: null, permissionMode: null },
      });
      const resolved = resolveColumnStrategy({ lane, profile });
      expect(resolved.model_override).toBeNull();
      expect(resolved.effort_override).toBeNull();
      expect(resolved.agent_override).toBeNull();
      expect(resolved.permission_mode).toBeNull();
    });

    it('distinguishes clear-to-null from inherit within one entry', () => {
      const lane = makeLane({ model_override: 'claude-opus-5', effort_override: 'xhigh' });
      const profile = makeProfile({ 'lane-executing': { modelOverride: null } });
      const resolved = resolveColumnStrategy({ lane, profile });
      expect(resolved.model_override).toBeNull();   // explicitly cleared
      expect(resolved.effort_override).toBe('xhigh'); // untouched, inherited
    });
  });

  // The column's message is NOT a strategy field any more. It is a
  // `send_message` automation, and automations are shared by every profile, so
  // a profile entry cannot re-point it. This pins the retirement in both
  // directions: the resolver stops carrying the two fields, and a profile
  // carrying the retired keys cannot resurrect them.
  describe('the retired message fields', () => {
    it('does not carry auto_command or auto_command_mode', () => {
      const resolved = resolveColumnStrategy({ lane: makeLane(), profile: null });
      expect(resolved).not.toHaveProperty('auto_command');
      expect(resolved).not.toHaveProperty('auto_command_mode');
    });

    it('ignores a profile entry that still carries the retired keys', () => {
      const profile = makeProfile({
        'lane-executing': { autoCommand: '/stale', autoCommandMode: 'deferred' } as unknown as BoardProfileEntry,
      });
      const resolved = resolveColumnStrategy({ lane: makeLane(), profile });
      expect(resolved).not.toHaveProperty('auto_command');
      expect(resolved).not.toHaveProperty('auto_command_mode');
      // And the rest of the fold still works, so the entry is not discarded
      // wholesale just because it carries a retired key.
      expect(resolved.model_override).toBe('claude-opus-5');
    });
  });

  describe('non-string fields', () => {
    it('overrides booleans when present and inherits when absent', () => {
      const lane = makeLane({ auto_spawn: true, handoff_context: true });
      const resolved = resolveColumnStrategy({
        lane,
        profile: makeProfile({ 'lane-executing': { autoSpawn: false } }),
      });
      expect(resolved.auto_spawn).toBe(false);
      expect(resolved.handoff_context).toBe(true);
    });

    it('overrides the session target and spawn strategy', () => {
      const lane = makeLane();
      const resolved = resolveColumnStrategy({
        lane,
        profile: makeProfile({
          'lane-executing': { sessionTarget: 'isolated', sessionSpawnStrategy: 'always_spawn_new' },
        }),
      });
      expect(resolved.session_target).toBe('isolated');
      expect(resolved.session_spawn_strategy).toBe('always_spawn_new');
    });
  });

  describe('planExitTarget - carried by NAME while every other key is by uuid', () => {
    const columns: Pick<Swimlane, 'id' | 'name'>[] = [
      { id: 'lane-review', name: 'Code Review' },
      { id: 'lane-tests', name: 'Tests' },
    ];

    it('resolves a column name to its swimlane id', () => {
      const resolved = resolveColumnStrategy({
        lane: makeLane(),
        profile: makeProfile({ 'lane-executing': { planExitTarget: 'Tests' } }),
        columns,
      });
      expect(resolved.plan_exit_target_id).toBe('lane-tests');
    });

    it('keeps the base target when the name does not resolve, rather than stranding the task', () => {
      const resolved = resolveColumnStrategy({
        lane: makeLane(),
        profile: makeProfile({ 'lane-executing': { planExitTarget: 'Renamed Away' } }),
        columns,
      });
      expect(resolved.plan_exit_target_id).toBe('lane-review');
    });

    it('keeps the base target when the caller passes no column list', () => {
      const resolved = resolveColumnStrategy({
        lane: makeLane(),
        profile: makeProfile({ 'lane-executing': { planExitTarget: 'Tests' } }),
      });
      expect(resolved.plan_exit_target_id).toBe('lane-review');
    });
  });

  it('does not mutate the lane or the profile', () => {
    const lane = makeLane();
    const profile = makeProfile({ 'lane-executing': { modelOverride: null } });
    const laneSnapshot = JSON.stringify(lane);
    const profileSnapshot = JSON.stringify(profile);
    resolveColumnStrategy({ lane, profile });
    expect(JSON.stringify(lane)).toBe(laneSnapshot);
    expect(JSON.stringify(profile)).toBe(profileSnapshot);
  });
});

describe('applyProfileToLane', () => {
  it('returns the same lane object when there is no profile', () => {
    const lane = makeLane();
    expect(applyProfileToLane(lane, null)).toBe(lane);
  });

  it('returns null for a null lane, so caller `lane?.x` guards keep working', () => {
    expect(applyProfileToLane(null, makeProfile({}))).toBeNull();
  });

  it('re-points strategy fields while leaving identity fields untouched', () => {
    // Identity (id, name, role, position, color, icon) is singular across
    // profiles - only strategy is profile-scoped.
    const lane = { ...makeLane(), name: 'Executing', role: null, position: 2, color: '#3b82f6', icon: 'square-terminal' };
    const folded = applyProfileToLane(
      lane,
      makeProfile({ 'lane-executing': { modelOverride: 'claude-sonnet-5' } }),
    );
    expect(folded).not.toBeNull();
    expect(folded!.model_override).toBe('claude-sonnet-5');
    expect(folded!.id).toBe('lane-executing');
    expect(folded!.name).toBe('Executing');
    expect(folded!.position).toBe(2);
    expect(folded!.icon).toBe('square-terminal');
  });

  it('does not mutate the original lane', () => {
    const lane = makeLane();
    applyProfileToLane(lane, makeProfile({ 'lane-executing': { modelOverride: 'claude-sonnet-5' } }));
    expect(lane.model_override).toBe('claude-opus-5');
  });

  it('preserves a todo/done role through a profile fold - the invariant auto-spawn.ts and resume-suspended.ts trust', () => {
    // Both NEVER_AUTO_SPAWN_ROLES call sites (auto-spawn.ts's lane filter,
    // resume-suspended.ts's neverSpawnRole guard) read `resolvedLane.role`
    // AFTER folding a profile in, on the strength of role being an identity
    // field a profile can never touch (see the comment above
    // `applyProfileToLane`). A profile CAN turn `auto_spawn` on for a
    // todo/done lane; it must never be able to make the fold report a
    // different role for it. autoSpawn is set here specifically because
    // that is the exact profile key both guards' regression scenario turns
    // on.
    const lane = { ...makeLane(), name: 'To Do', role: 'todo' as const, position: 0, color: '#888', icon: null };
    const folded = applyProfileToLane(
      lane,
      makeProfile({ 'lane-executing': { autoSpawn: true } }),
    );
    expect(folded).not.toBeNull();
    expect(folded!.role).toBe('todo');
    expect(folded!.auto_spawn).toBe(true);
  });

  it('produces the ladder the feature exists for', () => {
    const profile = makeProfile({
      'lane-planning': { modelOverride: 'claude-opus-5', effortOverride: 'xhigh' },
      'lane-executing': { modelOverride: 'claude-opus-5', effortOverride: 'high' },
      'lane-merge': { modelOverride: 'claude-sonnet-5', effortOverride: 'high' },
    });
    const rungFor = (id: string) => {
      const folded = applyProfileToLane(makeLane({ id, model_override: null, effort_override: null }), profile);
      return [folded!.model_override, folded!.effort_override];
    };
    expect(rungFor('lane-planning')).toEqual(['claude-opus-5', 'xhigh']);
    expect(rungFor('lane-executing')).toEqual(['claude-opus-5', 'high']);
    expect(rungFor('lane-merge')).toEqual(['claude-sonnet-5', 'high']);
  });
});

describe('resolveEffectiveAutoCommand', () => {
  // The bug this helper exists to close: the spawn path honored the task's own
  // auto_command while the live-injection path in task-move.ts read only the
  // destination lane. Same task, different behavior depending on whether the
  // destination happened to have a live session.
  it('prefers the task auto_command over the column', () => {
    expect(resolveEffectiveAutoCommand('/my-task-command', '/column-command')).toBe('/my-task-command');
  });

  it('falls back to the column when the task has none', () => {
    expect(resolveEffectiveAutoCommand(null, '/column-command')).toBe('/column-command');
  });

  it('returns null when neither tier has one, so callers keep their trim() guards', () => {
    expect(resolveEffectiveAutoCommand(null, null)).toBeNull();
    expect(resolveEffectiveAutoCommand(undefined, undefined)).toBeNull();
  });

  it('treats an empty-string task command as set, matching the spawn path\'s ?? semantics', () => {
    // '' is falsy but not nullish. Callers guard with `?.trim()`, so an empty
    // task command deliberately suppresses the column's rather than falling
    // through to it - preserving the pre-existing spawn-path behavior exactly.
    expect(resolveEffectiveAutoCommand('', '/column-command')).toBe('');
  });

  it('takes the column tier from resolveColumnMessage, which is the automation row', () => {
    // The column tier is no longer a lane field: both paths (the cold spawn and
    // the warm live injection) read the column's first enabled `send_message`
    // enter automation and hand THAT to this helper. Pinned here so a future
    // caller cannot go back to reading a lane.
    const message = resolveColumnMessage([
      { id: 'row-1', type: 'send_message', trigger: 'enter', enabled: true, position: 0, config: { message: '/column-command' } },
    ]);
    expect(resolveEffectiveAutoCommand(null, message?.message)).toBe('/column-command');
  });
});

describe('resolveColumnMessage', () => {
  it('picks the FIRST enabled send_message enter row by position', () => {
    const message = resolveColumnMessage([
      { id: 'row-2', type: 'send_message', trigger: 'enter', enabled: true, position: 1, config: { message: '/second' } },
      { id: 'row-1', type: 'send_message', trigger: 'enter', enabled: true, position: 0, config: { message: '/first' } },
    ]);
    expect(message).toEqual({ id: 'row-1', message: '/first', mode: 'immediate' });
  });

  it('skips a switched-off row, an exit row, and another type', () => {
    const message = resolveColumnMessage([
      { id: 'off', type: 'send_message', trigger: 'enter', enabled: false, position: 0, config: { message: '/off' } },
      { id: 'exit', type: 'send_message', trigger: 'exit', enabled: true, position: 1, config: { message: '/exit' } },
      { id: 'script', type: 'run_script', trigger: 'enter', enabled: true, position: 2, config: { script: 'echo hi' } },
    ]);
    expect(message).toBeNull();
  });

  it('carries the row\'s own mode, which is what the warm injection delivers with', () => {
    const message = resolveColumnMessage([
      { id: 'row-1', type: 'send_message', trigger: 'enter', enabled: true, position: 0, config: { message: '/x', mode: 'deferred' } },
    ]);
    expect(message?.mode).toBe('deferred');
  });

  it('reads the legacy `command` key a migrated send_command row still carries', () => {
    const message = resolveColumnMessage([
      { id: 'row-1', type: 'send_message', trigger: 'enter', enabled: true, position: 0, config: { command: '/legacy' } },
    ]);
    expect(message?.message).toBe('/legacy');
  });
});

describe('findTaskProfile', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  const profiles: BoardProfile[] = [
    { id: 'profile-a', name: 'Heavy', columns: {} },
    { id: 'profile-b', name: 'Frugal', columns: {} },
  ];

  it('returns null for a task on the synthetic Default profile', () => {
    expect(findTaskProfile({ profiles, profileId: null })).toBeNull();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('finds a profile by its stable id, not its display name', () => {
    expect(findTaskProfile({ profiles, profileId: 'profile-b' })?.name).toBe('Frugal');
  });

  // A teammate deleting a profile must never wedge an in-flight task: this runs
  // inside runSpawnPreamble, so throwing here would block the spawn outright.
  it('degrades a dangling profile id to Default instead of throwing', () => {
    expect(findTaskProfile({ profiles, profileId: 'deleted-profile', taskId: 'task-1' })).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('warns only once per task and profile, so a repeatedly-spawning task does not flood the log', () => {
    findTaskProfile({ profiles, profileId: 'also-deleted', taskId: 'task-2' });
    findTaskProfile({ profiles, profileId: 'also-deleted', taskId: 'task-2' });
    findTaskProfile({ profiles, profileId: 'also-deleted', taskId: 'task-2' });
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('handles an absent profiles array', () => {
    expect(findTaskProfile({ profiles: undefined, profileId: 'profile-a', taskId: 'task-3' })).toBeNull();
  });
});
