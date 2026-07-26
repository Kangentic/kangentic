import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  resolveColumnStrategy,
  findTaskProfile,
  resolveEffectiveAutoCommand,
  applyProfileToLane,
} from '../../src/main/transition-engine/column-strategy';
import type { BoardProfile, Swimlane } from '../../src/shared/types';
import type { LaneStrategyFields } from '../../src/main/transition-engine/column-strategy';

/** A base column that pins a full strategy, so "inherit" and "clear" are distinguishable. */
function makeLane(overrides: Partial<LaneStrategyFields> = {}): LaneStrategyFields {
  return {
    id: 'lane-executing',
    agent_override: 'claude',
    model_override: 'claude-opus-5',
    effort_override: 'high',
    permission_mode: 'auto',
    auto_command: '/implement',
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
        auto_command: '/implement',
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
        auto_command: null,
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
        'lane-executing': { modelOverride: null, effortOverride: null, agentOverride: null, permissionMode: null, autoCommand: null },
      });
      const resolved = resolveColumnStrategy({ lane, profile });
      expect(resolved.model_override).toBeNull();
      expect(resolved.effort_override).toBeNull();
      expect(resolved.agent_override).toBeNull();
      expect(resolved.permission_mode).toBeNull();
      expect(resolved.auto_command).toBeNull();
    });

    it('distinguishes clear-to-null from inherit within one entry', () => {
      const lane = makeLane({ model_override: 'claude-opus-5', effort_override: 'xhigh' });
      const profile = makeProfile({ 'lane-executing': { modelOverride: null } });
      const resolved = resolveColumnStrategy({ lane, profile });
      expect(resolved.model_override).toBeNull();   // explicitly cleared
      expect(resolved.effort_override).toBe('xhigh'); // untouched, inherited
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

  it('resolves the profile-folded column value, not the raw lane', () => {
    // In profile mode the caller passes strategy.auto_command, which has already
    // had the profile delta applied - so a profile that re-points a column's
    // command flows through both paths identically.
    const strategy = resolveColumnStrategy({
      lane: makeLane({ auto_command: '/base-command' }),
      profile: makeProfile({ 'lane-executing': { autoCommand: '/profile-command' } }),
    });
    expect(resolveEffectiveAutoCommand(null, strategy.auto_command)).toBe('/profile-command');
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
