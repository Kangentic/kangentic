/**
 * `decideLiveSessionFate` says what a move does to a live session whose
 * destination keeps an agent, in the order `handleTaskMove`'s Priority 3 tests
 * it. The exit hook and Priority 3 both read the one answer, decided before the
 * exit group (kangentic.com #145): a restart carries the exit message to the resume, a switch
 * or handoff skips it, and a kept session gets it typed. If the order slipped,
 * the hook would carry or skip a message for a move that then did something else.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Project, Swimlane, Task } from '../../src/shared/types';
import type { SessionRepository } from '../../src/main/db/repositories/session-repository';
import { decideLiveSessionFate, readLiveSessionFate, type LiveSessionFateFacts } from '../../src/main/ipc/helpers/live-session-fate';
import { prepareInjectionPlan } from '../../src/main/transition-engine/injection-plan';
import { resolveTargetAgent } from '../../src/main/transition-engine/agent-resolver';

vi.mock('../../src/main/transition-engine/injection-plan', () => ({
  prepareInjectionPlan: vi.fn(),
  resolveReportedEffort: vi.fn(() => ({})),
}));
vi.mock('../../src/main/transition-engine/agent-resolver', () => ({
  resolveTargetAgent: vi.fn(),
}));
vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: { get: vi.fn(() => undefined) },
}));

const KEEP: LiveSessionFateFacts = {
  hasDestination: true,
  activeIsolatedSwimlaneId: null,
  targetIsolatedSwimlaneId: null,
  targetForceFresh: false,
  targetAgent: 'claude',
  isAgentChange: false,
  restartReason: null,
  sessionRunning: true,
  columnBlocks: false,
};

describe('decideLiveSessionFate', () => {
  it('keeps the session when nothing changes', () => {
    expect(decideLiveSessionFate(KEEP)).toEqual({ kind: 'keep' });
  });

  it('switches into an isolated column, back to main, or into a column that always starts fresh', () => {
    expect(decideLiveSessionFate({ ...KEEP, targetIsolatedSwimlaneId: 'lane-review' })).toEqual({ kind: 'switch' });
    expect(decideLiveSessionFate({ ...KEEP, activeIsolatedSwimlaneId: 'lane-review' })).toEqual({ kind: 'switch' });
    expect(decideLiveSessionFate({ ...KEEP, targetForceFresh: true })).toEqual({ kind: 'switch' });
  });

  it('never switches with no destination column', () => {
    expect(decideLiveSessionFate({ ...KEEP, hasDestination: false, activeIsolatedSwimlaneId: 'lane-review' })).toEqual({ kind: 'keep' });
  });

  it('a switch wins over a handoff, a restart and a full column', () => {
    expect(decideLiveSessionFate({
      ...KEEP,
      targetForceFresh: true,
      isAgentChange: true,
      restartReason: 'model',
      columnBlocks: true,
    })).toEqual({ kind: 'switch' });
  });

  it('a handoff wins over a restart and a full column, and names the agent', () => {
    expect(decideLiveSessionFate({
      ...KEEP,
      targetAgent: 'codex',
      isAgentChange: true,
      restartReason: 'effort',
      columnBlocks: true,
    })).toEqual({ kind: 'handoff', targetAgent: 'codex' });
  });

  it('restarts for a model or effort change, ahead of a full column', () => {
    expect(decideLiveSessionFate({ ...KEEP, restartReason: 'model', columnBlocks: true })).toEqual({ kind: 'restart', reason: 'model' });
    expect(decideLiveSessionFate({ ...KEEP, restartReason: 'effort' })).toEqual({ kind: 'restart', reason: 'effort' });
  });

  it('yields to a full column only for a running session', () => {
    expect(decideLiveSessionFate({ ...KEEP, columnBlocks: true })).toEqual({ kind: 'yield' });
    expect(decideLiveSessionFate({ ...KEEP, columnBlocks: true, sessionRunning: false })).toEqual({ kind: 'keep' });
  });
});

describe('readLiveSessionFate', () => {
  const TASK_ID = 'task-fate-0001';
  const LIVE_SESSION_ID = 'live-session-1';
  const task = { id: TASK_ID, agent: 'claude', agent_override: null } as unknown as Task;
  const project = { id: 'project-1', default_agent: 'claude' } as unknown as Project;

  function makeLane(overrides: Partial<Swimlane> = {}): Swimlane {
    return {
      id: 'lane-destination',
      agent_override: null,
      session_target: 'main',
      session_spawn_strategy: 'create_or_resume',
      ...overrides,
    } as unknown as Swimlane;
  }

  function makeInput(options: { toLane?: Swimlane; sessionStatus?: string | null; columnBlocks?: boolean } = {}) {
    const sessionManager = {
      getSession: vi.fn(() => (options.sessionStatus === null ? undefined : { status: options.sessionStatus ?? 'running' })),
      columnBlocks: vi.fn(() => options.columnBlocks ?? false),
    };
    const sessionRepo = { getLatestForTask: vi.fn(() => ({ isolated_swimlane_id: null })) };
    const input = {
      context: { sessionManager } as never,
      sessionRepo: sessionRepo as unknown as SessionRepository,
      task,
      liveSessionId: LIVE_SESSION_ID,
      toLane: options.toLane ?? makeLane(),
      project,
      projectId: 'project-1',
    };
    return { input, sessionManager };
  }

  beforeEach(() => {
    vi.mocked(prepareInjectionPlan).mockReset().mockReturnValue(null);
    vi.mocked(resolveTargetAgent).mockReset().mockReturnValue({ agent: 'claude', isHandoff: false });
  });

  it.each([
    ['an isolated destination', { session_target: 'isolated' as const }],
    ['a destination that always starts a new session', { session_spawn_strategy: 'always_spawn_new' as const }],
  ])('a switch (%s) reads neither the restart rule nor the session nor the column gate', (_label, laneOverrides) => {
    const { input, sessionManager } = makeInput({ toLane: makeLane(laneOverrides) });

    expect(readLiveSessionFate(input)).toEqual({ kind: 'switch' });

    expect(prepareInjectionPlan).not.toHaveBeenCalled();
    expect(sessionManager.getSession).not.toHaveBeenCalled();
    expect(sessionManager.columnBlocks).not.toHaveBeenCalled();
  });

  it('a handoff names the agent and reads neither the restart rule nor the session nor the column gate', () => {
    vi.mocked(resolveTargetAgent).mockReturnValue({ agent: 'codex', isHandoff: true });
    const { input, sessionManager } = makeInput();

    expect(readLiveSessionFate(input)).toEqual({ kind: 'handoff', targetAgent: 'codex' });

    expect(prepareInjectionPlan).not.toHaveBeenCalled();
    expect(sessionManager.getSession).not.toHaveBeenCalled();
    expect(sessionManager.columnBlocks).not.toHaveBeenCalled();
  });

  it('asks the restart rule with no message, so the column message cannot change the answer', () => {
    const { input } = makeInput();

    readLiveSessionFate(input);

    expect(prepareInjectionPlan).toHaveBeenCalledTimes(1);
    expect(vi.mocked(prepareInjectionPlan).mock.calls[0][0].autoCommand).toBe('');
  });

  it('a restart reason from the plan is a restart, and the column gate and session are never read', () => {
    vi.mocked(prepareInjectionPlan).mockReturnValue({ sequence: [], verifier: null, restartReason: 'effort' });
    const { input, sessionManager } = makeInput({ columnBlocks: true });

    expect(readLiveSessionFate(input)).toEqual({ kind: 'restart', reason: 'effort' });

    expect(sessionManager.getSession).not.toHaveBeenCalled();
    expect(sessionManager.columnBlocks).not.toHaveBeenCalled();
  });

  it('a running session in a full column yields, asking the gate for this task and project', () => {
    const { input, sessionManager } = makeInput({ columnBlocks: true });

    expect(readLiveSessionFate(input)).toEqual({ kind: 'yield' });

    expect(sessionManager.columnBlocks).toHaveBeenCalledWith({ taskId: TASK_ID, projectId: 'project-1' });
  });

  it('a queued session is kept, and the column gate is not asked', () => {
    const { input, sessionManager } = makeInput({ sessionStatus: 'queued', columnBlocks: true });

    expect(readLiveSessionFate(input)).toEqual({ kind: 'keep' });

    expect(sessionManager.getSession).toHaveBeenCalledWith(LIVE_SESSION_ID);
    expect(sessionManager.columnBlocks).not.toHaveBeenCalled();
  });

  it('keeps a running session in a column with room', () => {
    const { input, sessionManager } = makeInput({ columnBlocks: false });

    expect(readLiveSessionFate(input)).toEqual({ kind: 'keep' });

    expect(sessionManager.columnBlocks).toHaveBeenCalledTimes(1);
  });
});
