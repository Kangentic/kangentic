/**
 * A project's default_model / default_effort must not follow a task or column
 * that overrides the AGENT.
 *
 * Model and effort ids are adapter-specific, so a project default chosen for
 * the project's agent is meaningless - usually fatal - for a different one.
 * Shipped symptom: a project on `claude` with `default_model: "haiku"` and a
 * column overriding the agent to `codex` spawned `codex --model haiku`, and
 * Codex rejected the turn outright with
 * `The requested model 'haiku' does not exist` (400).
 *
 * The gate lives in one place (`projectModelDefaultsApply`) and is applied at
 * four resolution sites, all of which must agree or a move/respawn would
 * inject or apply a model the original spawn never used:
 *   1. the board spawn path (`resolveSpawnOverrides`) - pinned in this file
 *   2. the first-spawn Advanced lock (`lockAdvancedOverridesOnFirstSpawn`) -
 *      pinned in spawn-agent-lock-overrides.test.ts
 *   3. the column-move `/model`/`/effort` injection plan
 *      (`prepareInjectionPlan`) - pinned in injection-plan.test.ts (see
 *      "project-level default gated by agent match (cross-agent)")
 *   4. the startup/crash-recovery spawn chokepoint (`prepareAgentSpawn`) -
 *      pinned in prepare-spawn-first-spawn-lock.test.ts
 */
import { describe, it, expect } from 'vitest';
import { resolveSpawnOverrides } from '../../src/main/ipc/helpers/agent-spawn';
import { projectModelDefaultsApply } from '../../src/main/transition-engine/spawn-preamble';
import type { SessionTarget, SessionSpawnStrategy } from '../../src/shared/types';

type TaskFields = {
  agent_override: string | null;
  model_override: string | null;
  effort_override: string | null;
};

type LaneFields = {
  id: string;
  agent_override: string | null;
  model_override: string | null;
  effort_override: string | null;
  session_target: SessionTarget;
  session_spawn_strategy: SessionSpawnStrategy;
};

type ProjectFields = {
  default_agent: string | null;
  default_model: string | null;
  default_effort: string | null;
};

const task = (overrides: Partial<TaskFields> = {}): TaskFields => ({
  agent_override: null,
  model_override: null,
  effort_override: null,
  ...overrides,
});

const lane = (overrides: Partial<LaneFields> = {}): LaneFields => ({
  id: 'lane-1',
  agent_override: null,
  model_override: null,
  effort_override: null,
  session_target: 'main',
  session_spawn_strategy: 'create_or_resume',
  ...overrides,
});

const project: ProjectFields = {
  default_agent: 'claude',
  default_model: 'haiku',
  default_effort: 'low',
};

describe('projectModelDefaultsApply', () => {
  it('applies when the resolved agent is the project default', () => {
    expect(projectModelDefaultsApply('claude', 'claude')).toBe(true);
  });

  it('does not apply when the resolved agent differs', () => {
    expect(projectModelDefaultsApply('codex', 'claude')).toBe(false);
    expect(projectModelDefaultsApply('gemini', 'claude')).toBe(false);
  });

  it('falls back to DEFAULT_AGENT when the project sets none', () => {
    // A project row with no default_agent still runs the app default, so a
    // column on that same agent should keep inheriting the project tier.
    expect(projectModelDefaultsApply('claude', null)).toBe(true);
    expect(projectModelDefaultsApply('codex', null)).toBe(false);
  });
});

describe('resolveSpawnOverrides - project tier across agents', () => {
  it('inherits the project model/effort when no agent override is present', () => {
    const resolved = resolveSpawnOverrides(task(), lane(), project);
    expect(resolved.model).toBe('haiku');
    expect(resolved.effort).toBe('low');
  });

  it('drops the project model/effort when the COLUMN overrides the agent', () => {
    const resolved = resolveSpawnOverrides(task(), lane({ agent_override: 'codex' }), project);
    expect(resolved.model).toBeUndefined();
    expect(resolved.effort).toBeUndefined();
  });

  it('drops the project model/effort when the TASK overrides the agent', () => {
    const resolved = resolveSpawnOverrides(task({ agent_override: 'codex' }), lane(), project);
    expect(resolved.model).toBeUndefined();
    expect(resolved.effort).toBeUndefined();
  });

  it('keeps inheriting when the override names the project default agent', () => {
    const resolved = resolveSpawnOverrides(task(), lane({ agent_override: 'claude' }), project);
    expect(resolved.model).toBe('haiku');
  });

  it('still honors a COLUMN model override on an agent-overriding column', () => {
    // Only the project tier is gated: a column's own model was chosen
    // alongside that column's agent, so the two are already coherent.
    const resolved = resolveSpawnOverrides(
      task(),
      lane({ agent_override: 'codex', model_override: 'gpt-5.5', effort_override: 'medium' }),
      project,
    );
    expect(resolved.model).toBe('gpt-5.5');
    expect(resolved.effort).toBe('medium');
  });

  it('still honors a TASK model override on an agent-overriding task', () => {
    const resolved = resolveSpawnOverrides(
      task({ agent_override: 'codex', model_override: 'gpt-5.5' }),
      lane(),
      project,
    );
    expect(resolved.model).toBe('gpt-5.5');
  });

  it('a task agent override beats a column agent override for gating', () => {
    // Task wins the agent ladder, so a task pinned back to the project default
    // re-enables the project tier even under an agent-overriding column.
    const resolved = resolveSpawnOverrides(
      task({ agent_override: 'claude' }),
      lane({ agent_override: 'codex' }),
      project,
    );
    expect(resolved.model).toBe('haiku');
  });
});
