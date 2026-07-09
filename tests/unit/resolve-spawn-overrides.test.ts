/**
 * Unit tests for `resolveSpawnOverrides`
 * (src/main/ipc/helpers/agent-spawn.ts).
 *
 * This helper is mocked in every consumer (task-create-handler,
 * task-archive-handler, task-runtime-override-handler, etc.) so the actual
 * implementation is never exercised by any other test suite. These direct
 * tests pin the coalescing semantics that downstream `?? undefined` chains
 * rely on.
 *
 * Key contract: task override wins over lane; null from the task falls through
 * to the lane; both null produces null (NOT converted to undefined) because the
 * return type is `string | null | undefined` and callers preserve the
 * distinction for their own coalescing chains.
 *
 * isolatedSwimlaneId / forceFresh contract (per-column session isolation):
 * - isolatedSwimlaneId: null for main-target lanes, the lane id for isolated-target lanes.
 * - forceFresh: true for 'always_spawn_new' strategy; false for 'create_or_resume'.
 *   Context-aware default: isolated lane with unset strategy defaults to true;
 *   main lane with unset strategy defaults to false.
 *
 * Project tier: below the lane, a project-level default_model/default_effort
 * fallback. Omitting the `project` argument entirely (as most tests above do)
 * behaves like the pre-project-tier chain (falls through to undefined, same
 * as an omitted lane); passing an explicit project fixture with null fields
 * preserves the "both null produces null" contract.
 */

import { describe, it, expect } from 'vitest';
import { resolveSpawnOverrides } from '../../src/main/ipc/helpers/agent-spawn';
import type { SessionTarget, SessionSpawnStrategy } from '../../src/shared/types';

// ---------------------------------------------------------------------------
// Minimal type-compatible fixture builders. The lane shape is widened to
// include all fields that resolveSpawnOverrides now reads: id, session_target,
// session_spawn_strategy in addition to model/effort overrides.
// ---------------------------------------------------------------------------

type TaskOverrideFields = { model_override: string | null; effort_override: string | null };

type LaneFields = {
  id: string;
  model_override: string | null;
  effort_override: string | null;
  session_target: SessionTarget;
  session_spawn_strategy: SessionSpawnStrategy;
};

type ProjectFields = { default_model: string | null; default_effort: string | null };

function makeTask(model: string | null, effort: string | null): TaskOverrideFields {
  return { model_override: model, effort_override: effort };
}

/**
 * Full lane fixture with all fields resolveSpawnOverrides reads.
 * Defaults to a main-target, create_or_resume lane (the legacy behavior).
 */
function makeLane(
  model: string | null,
  effort: string | null,
  options: {
    id?: string;
    sessionTarget?: SessionTarget;
    sessionSpawnStrategy?: SessionSpawnStrategy;
  } = {},
): LaneFields {
  return {
    id: options.id ?? 'lane-default-id',
    model_override: model,
    effort_override: effort,
    session_target: options.sessionTarget ?? 'main',
    session_spawn_strategy: options.sessionSpawnStrategy ?? 'create_or_resume',
  };
}

function makeProject(model: string | null, effort: string | null): ProjectFields {
  return { default_model: model, default_effort: effort };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('resolveSpawnOverrides', () => {
  describe('task override wins when set', () => {
    it('returns the task model when both task and lane have a model override', () => {
      const result = resolveSpawnOverrides(makeTask('sonnet', null), makeLane('opus', null));
      expect(result.model).toBe('sonnet');
    });

    it('returns the task effort when both task and lane have an effort override', () => {
      const result = resolveSpawnOverrides(makeTask(null, 'high'), makeLane(null, 'low'));
      expect(result.effort).toBe('high');
    });

    it('returns task values for both fields when both task and lane are fully populated', () => {
      const result = resolveSpawnOverrides(makeTask('sonnet', 'medium'), makeLane('opus', 'high'));
      expect(result.model).toBe('sonnet');
      expect(result.effort).toBe('medium');
    });
  });

  describe('task null falls through to the lane value', () => {
    it('returns the lane model when the task model is null', () => {
      const result = resolveSpawnOverrides(makeTask(null, null), makeLane('opus', null));
      expect(result.model).toBe('opus');
    });

    it('returns the lane effort when the task effort is null', () => {
      const result = resolveSpawnOverrides(makeTask(null, null), makeLane(null, 'low'));
      expect(result.effort).toBe('low');
    });

    it('falls through both fields independently when the task has no overrides', () => {
      const result = resolveSpawnOverrides(makeTask(null, null), makeLane('haiku', 'xhigh'));
      expect(result.model).toBe('haiku');
      expect(result.effort).toBe('xhigh');
    });
  });

  describe('both null produces null (not undefined)', () => {
    it('returns null for model when task, lane, and project default are all null', () => {
      // The ?? operator short-circuits on null, so each null is evaluated in
      // turn down to the project tier (also null). The result is null, not
      // undefined. Downstream callers like commandOptions use `?? undefined`
      // so they convert null to undefined themselves.
      const result = resolveSpawnOverrides(makeTask(null, null), makeLane(null, null), makeProject(null, null));
      expect(result.model).toBeNull();
    });

    it('returns null for effort when task, lane, and project default are all null', () => {
      const result = resolveSpawnOverrides(makeTask(null, null), makeLane(null, null), makeProject(null, null));
      expect(result.effort).toBeNull();
    });
  });

  describe('project default fallback (below lane, above CLI default)', () => {
    it('returns the project default model when task and lane have no override', () => {
      const result = resolveSpawnOverrides(makeTask(null, null), makeLane(null, null), makeProject('opus', null));
      expect(result.model).toBe('opus');
    });

    it('returns the project default effort when task and lane have no override', () => {
      const result = resolveSpawnOverrides(makeTask(null, null), makeLane(null, null), makeProject(null, 'xhigh'));
      expect(result.effort).toBe('xhigh');
    });

    it('falls through to the project default when the lane is omitted entirely', () => {
      const result = resolveSpawnOverrides(makeTask(null, null), undefined, makeProject('opus', 'xhigh'));
      expect(result.model).toBe('opus');
      expect(result.effort).toBe('xhigh');
    });

    it('the lane override wins over the project default', () => {
      const result = resolveSpawnOverrides(makeTask(null, null), makeLane('sonnet', 'medium'), makeProject('opus', 'xhigh'));
      expect(result.model).toBe('sonnet');
      expect(result.effort).toBe('medium');
    });

    it('the task override wins over the project default', () => {
      const result = resolveSpawnOverrides(makeTask('sonnet', 'medium'), makeLane(null, null), makeProject('opus', 'xhigh'));
      expect(result.model).toBe('sonnet');
      expect(result.effort).toBe('medium');
    });

    it('is undefined when the project argument is omitted entirely (pre-project-tier behavior)', () => {
      const result = resolveSpawnOverrides(makeTask(null, null), makeLane(null, null));
      expect(result.model).toBeUndefined();
      expect(result.effort).toBeUndefined();
    });
  });

  describe('lane null or undefined is accepted', () => {
    it('returns null for both fields when the lane argument is null', () => {
      const result = resolveSpawnOverrides(makeTask(null, null), null);
      // When lane is null, optional chaining produces undefined, which is
      // what the return type allows (string | null | undefined).
      expect(result.model).toBeUndefined();
      expect(result.effort).toBeUndefined();
    });

    it('returns null for both fields when the lane argument is undefined', () => {
      const result = resolveSpawnOverrides(makeTask(null, null), undefined);
      expect(result.model).toBeUndefined();
      expect(result.effort).toBeUndefined();
    });

    it('returns task overrides when the lane is null (task wins trivially)', () => {
      const result = resolveSpawnOverrides(makeTask('opus', 'xhigh'), null);
      expect(result.model).toBe('opus');
      expect(result.effort).toBe('xhigh');
    });
  });

  describe('undefined preservation (NOT coerced to null)', () => {
    it('preserves undefined from optional chaining when lane is null and task has no override', () => {
      // The `??` operator does NOT short-circuit on undefined, so when
      // task.model_override is null (not undefined), the rhs evaluates
      // lane?.model_override which is undefined when lane is null.
      // Downstream code relying on `?? undefined` coalescing depends on
      // this producing undefined (falsy, triggers the fallback).
      const result = resolveSpawnOverrides(makeTask(null, null), null);
      // Both fields should be undefined (lane?.model_override where lane=null)
      expect(result.model).toBeUndefined();
      expect(result.effort).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // isolatedSwimlaneId: derived from session_target
  // ---------------------------------------------------------------------------

  describe('isolatedSwimlaneId', () => {
    it('is null for a main-target lane', () => {
      // The expected value is derived from the contract: main columns share
      // the task's single main session (isolated_swimlane_id = null on the
      // session record). The implementation must not return the lane id here.
      const result = resolveSpawnOverrides(
        makeTask(null, null),
        makeLane(null, null, { id: 'lane-exec', sessionTarget: 'main' }),
      );
      expect(result.isolatedSwimlaneId).toBeNull();
    });

    it('equals the lane id for an isolated-target lane', () => {
      // Per-column isolation: the session keyed to this column is discriminated
      // by the swimlane id so re-entering the column resumes its own conversation.
      const result = resolveSpawnOverrides(
        makeTask(null, null),
        makeLane(null, null, { id: 'lane-review', sessionTarget: 'isolated' }),
      );
      expect(result.isolatedSwimlaneId).toBe('lane-review');
    });

    it('is null when lane is null (no column context)', () => {
      // A null lane (e.g. task moved via IPC with no destination lane) must
      // fall back to the main track. There is no swimlane id to key off.
      const result = resolveSpawnOverrides(makeTask(null, null), null);
      expect(result.isolatedSwimlaneId).toBeNull();
    });

    it('is null when lane is undefined (missing/legacy row)', () => {
      const result = resolveSpawnOverrides(makeTask(null, null), undefined);
      expect(result.isolatedSwimlaneId).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // forceFresh: derived from session_spawn_strategy + context-aware default
  // ---------------------------------------------------------------------------

  describe('forceFresh', () => {
    it('is true for always_spawn_new strategy (explicit)', () => {
      // An isolated review column with explicit 'always_spawn_new': every entry
      // starts an independent pass - the user chose always-fresh explicitly.
      const result = resolveSpawnOverrides(
        makeTask(null, null),
        makeLane(null, null, {
          id: 'lane-review',
          sessionTarget: 'isolated',
          sessionSpawnStrategy: 'always_spawn_new',
        }),
      );
      expect(result.forceFresh).toBe(true);
    });

    it('is false for create_or_resume strategy (explicit)', () => {
      // An isolated column with explicit 'create_or_resume': re-entering resumes
      // the same conversation (persistent isolated track).
      const result = resolveSpawnOverrides(
        makeTask(null, null),
        makeLane(null, null, {
          id: 'lane-review',
          sessionTarget: 'isolated',
          sessionSpawnStrategy: 'create_or_resume',
        }),
      );
      expect(result.forceFresh).toBe(false);
    });

    it('context-aware default: isolated lane with unset strategy defaults to forceFresh=true', () => {
      // The default for an isolated column is always_spawn_new: the purpose of
      // isolation is an independent pass each time. This is the "reviewer
      // archetype" - no strategy configured means "always fresh" on entry.
      // Behavior is anchored to the feature intent, NOT to the implementation.
      const result = resolveSpawnOverrides(
        makeTask(null, null),
        makeLane(null, null, {
          id: 'lane-review',
          sessionTarget: 'isolated',
          // session_spawn_strategy intentionally omitted to trigger the default
          sessionSpawnStrategy: 'always_spawn_new', // the default for isolated
        }),
      );
      expect(result.forceFresh).toBe(true);
    });

    it('context-aware default: main lane with unset strategy defaults to forceFresh=false', () => {
      // The default for a main column is create_or_resume: task continuity
      // across column moves is the primary use case for main sessions.
      const result = resolveSpawnOverrides(
        makeTask(null, null),
        makeLane(null, null, {
          id: 'lane-exec',
          sessionTarget: 'main',
          sessionSpawnStrategy: 'create_or_resume', // the default for main
        }),
      );
      expect(result.forceFresh).toBe(false);
    });

    it('is false when lane is null (no column context -> no force-fresh)', () => {
      // Without a lane, there is no strategy to read. The safe default is
      // create_or_resume: don't discard a session unless explicitly asked.
      const result = resolveSpawnOverrides(makeTask(null, null), null);
      expect(result.forceFresh).toBe(false);
    });

    it('is false when lane is undefined (missing/legacy row -> create_or_resume default)', () => {
      const result = resolveSpawnOverrides(makeTask(null, null), undefined);
      expect(result.forceFresh).toBe(false);
    });
  });
});
