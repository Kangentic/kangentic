/**
 * What an update of an SSH host's program reads of this app's sessions (`program-update-sessions.ts`, task
 * #1227): whether each is between turns, and the pause it asks for. The updater's own tests take this
 * answer as given, so this is where a turn, an open prompt, a typed draft or a message on its way must read
 * as "not now".
 *
 * What a user loses if it breaks: a remote agent cut off mid-turn, a question it asked thrown away, a draft
 * lost, or an agent left paused after the update as if the user had paused it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const heldDeliveryPending = vi.hoisted(() => ({ value: false }));
const messageDeliveryPending = vi.hoisted(() => ({ value: false }));
const moveFollowUp = vi.hoisted(() => ({ value: false }));
const turnEndGroup = vi.hoisted(() => ({ value: false }));
const spawnsInFlight = vi.hoisted((): { value: Record<string, string> } => ({ value: {} }));
const workflowRecovery = vi.hoisted(() => ({ value: false }));
const pauseTaskSession = vi.hoisted(() => vi.fn(async () => 'paused' as const));
vi.mock('../../src/main/held-messages/held-messages', () => ({ hasHeldDeliveryPending: () => heldDeliveryPending.value }));
vi.mock('../../src/main/automations/turn-end/turn-end-passes', () => ({
  hasPendingMessageDelivery: () => messageDeliveryPending.value,
  hasMoveFollowUp: () => moveFollowUp.value,
  hasTurnEndGroup: () => turnEndGroup.value,
}));
vi.mock('../../src/main/transition-engine/spawn-progress', () => ({ getInFlightSpawnProgress: () => spawnsInFlight.value }));
vi.mock('../../src/main/workflows/workflow-recovery-state', () => ({ isUnderWorkflowRecovery: () => workflowRecovery.value }));
vi.mock('../../src/main/ipc/handlers/session-pause', () => ({ pauseTaskSession }));
const resumeSessionsAfterProgramUpdate = vi.hoisted(() => vi.fn());
const endCommandTerminalForRestart = vi.hoisted(() => vi.fn());
const commandTerminalRestartability = vi.hoisted(() => vi.fn());
vi.mock('../../src/main/ipc/handlers/projects', () => ({ resumeSessionsAfterProgramUpdate }));
vi.mock('../../src/main/ipc/handlers/transient-sessions', () => ({ endCommandTerminalForRestart, commandTerminalRestartability }));

import { programUpdateSessionDeps } from '../../src/main/ipc/helpers/program-update-sessions';
import type { HeldRemoteSession } from '../../src/main/remote/program-update';

interface SessionState {
  activity: 'idle' | 'thinking' | 'permission';
  blocker: string | null;
  draft: string | null;
  backgroundShells: number;
  subagentDepth: number;
}

function makeContext(state: SessionState, submitPending = false, sessionFields: Record<string, unknown> = {}) {
  const sessionManager = {
    automatedKeysBlocker: () => state.blocker,
    getOpenWork: () => ({ toolCalls: [], backgroundShells: Array.from({ length: state.backgroundShells }, () => ({})), backgroundSubagents: [] }),
    getActivityStatsSnapshot: () => ({ subagentDepth: state.subagentDepth }),
    getPendingDraft: () => state.draft,
    getActivityCache: () => ({ 'session-1': state.activity }),
    readPendingDraft: async () => state.draft,
    liveRemotePtys: () => [{ sessionId: 'session-1', ptyId: 1 }],
    getSession: () => ({ id: 'session-1', taskId: 'task-1', projectId: 'project-1', transient: false, ...sessionFields }),
  };
  return { sessionManager, terminalSubmitScheduler: { hasPending: () => submitPending } };
}

const task: HeldRemoteSession = { sessionId: 'session-1', taskId: 'task-1', projectId: 'project-1', kind: 'task' };
const idle = (): SessionState => ({ activity: 'idle', blocker: null, draft: null, backgroundShells: 0, subagentDepth: 0 });

beforeEach(() => {
  heldDeliveryPending.value = false;
  messageDeliveryPending.value = false;
  moveFollowUp.value = false;
  turnEndGroup.value = false;
  spawnsInFlight.value = {};
  workflowRecovery.value = false;
  pauseTaskSession.mockClear();
  resumeSessionsAfterProgramUpdate.mockReset();
  endCommandTerminalForRestart.mockReset();
  commandTerminalRestartability.mockReset();
});

describe('whether a session is between turns', () => {
  it('reads an agent idle at its prompt with nothing open as at its safe point', () => {
    const deps = programUpdateSessionDeps(() => makeContext(idle()) as never);
    expect(deps.isAtSafePoint(task)).toBe(true);
  });

  it.each<[string, (state: SessionState) => void]>([
    ['in a turn', (state) => { state.activity = 'thinking'; }],
    ['with a question or permission prompt open', (state) => { state.activity = 'permission'; state.blocker = 'permission prompt open'; }],
    ['with a draft typed', (state) => { state.draft = 'half a sentence'; }],
    ['with a background shell running', (state) => { state.backgroundShells = 1; }],
  ])('reads an agent %s as not at its safe point', (_label, change) => {
    const state = idle();
    change(state);
    const deps = programUpdateSessionDeps(() => makeContext(state) as never);
    expect(deps.isAtSafePoint(task)).toBe(false);
  });

  it.each([
    ['a held message is on its way', () => { heldDeliveryPending.value = true; }, false],
    ['a column message is waiting to paste', () => { messageDeliveryPending.value = true; }, false],
    ['a keystroke burst is waiting', () => undefined, true],
    ['a moved task\'s message is waiting for it', () => { moveFollowUp.value = true; }, false],
    ['turn-end automations are still running', () => { turnEndGroup.value = true; }, false],
    ['its task is starting', () => { spawnsInFlight.value = { 'task-1': 'Starting agent' }; }, false],
    ['a workflow is recovering its task', () => { workflowRecovery.value = true; }, false],
  ])('reads an idle agent as not at its safe point when %s', (_label, arrange, submitPending) => {
    arrange();
    const deps = programUpdateSessionDeps(() => makeContext(idle(), submitPending) as never);
    expect(deps.isAtSafePoint(task)).toBe(false);
  });

  it('counts a start anywhere as in flight, since one past the launch check could land on the old program', () => {
    const deps = programUpdateSessionDeps(() => makeContext(idle()) as never);
    expect(deps.hasStartInFlight()).toBe(false);
    spawnsInFlight.value = { 'task-elsewhere': 'Starting agent' };
    expect(deps.hasStartInFlight()).toBe(true);
  });

  it('lists the host\'s sessions with their kind', () => {
    const deps = programUpdateSessionDeps(() => makeContext(idle()) as never);
    expect(deps.heldSessions('host-1')).toEqual([task]);
  });

  it.each<[string, Record<string, unknown>, HeldRemoteSession['kind']]>([
    ['a task agent', {}, 'task'],
    ['a Command Terminal', { transient: true }, 'command-terminal'],
    ['a workflow\'s own agent', { transient: true, workflowId: 'workflow-1' }, 'workflow'],
  ])('lists %s as kind %s', (_label, fields, kind) => {
    const deps = programUpdateSessionDeps(() => makeContext(idle(), false, fields) as never);
    expect(deps.heldSessions('host-1').map((held) => held.kind)).toEqual([kind]);
  });

  it('reads a draft as fresh only when something other than whitespace is typed', async () => {
    const draftOf = async (draft: string | null) => {
      const state = idle();
      state.draft = draft;
      return programUpdateSessionDeps(() => makeContext(state) as never).hasFreshDraft('session-1');
    };
    expect(await draftOf(null)).toBe(false);
    expect(await draftOf('  \n\t ')).toBe(false);
    expect(await draftOf('half a sentence')).toBe(true);
  });
});

describe('stopping and bringing back a Command Terminal', () => {
  const terminal: HeldRemoteSession = { sessionId: 'session-1', taskId: null, projectId: 'project-1', kind: 'command-terminal' };

  it('passes a refused or deferred end straight through', () => {
    const deps = programUpdateSessionDeps(() => makeContext(idle()) as never);
    endCommandTerminalForRestart.mockReturnValueOnce('failed');
    expect(deps.endTerminal(terminal, () => true)).toBe('failed');
    endCommandTerminalForRestart.mockReturnValueOnce('deferred');
    expect(deps.endTerminal(terminal, () => true)).toBe('deferred');
    expect(endCommandTerminalForRestart).toHaveBeenCalledWith(expect.anything(), 'session-1', expect.any(Function));
  });

  it('starts an ended terminal again on its account, or with no account when it had none', async () => {
    const deps = programUpdateSessionDeps(() => makeContext(idle()) as never);
    const startAgain = vi.fn(async () => undefined);
    const giveUp = vi.fn();

    endCommandTerminalForRestart.mockReturnValueOnce({ accountId: 'account-1', startAgain, giveUp });
    const withAccount = deps.endTerminal(terminal, () => true);
    if (typeof withAccount === 'string') throw new Error('expected an ended terminal');
    await withAccount.startAgain();
    expect(startAgain).toHaveBeenLastCalledWith({ accountId: 'account-1' });

    endCommandTerminalForRestart.mockReturnValueOnce({ accountId: null, startAgain, giveUp });
    const withoutAccount = deps.endTerminal(terminal, () => true);
    if (typeof withoutAccount === 'string') throw new Error('expected an ended terminal');
    await withoutAccount.startAgain();
    expect(startAgain).toHaveBeenLastCalledWith({});

    withoutAccount.giveUp();
    expect(giveUp).toHaveBeenCalledTimes(1);
  });

  it('asks the handler whether a terminal can be restarted', () => {
    const deps = programUpdateSessionDeps(() => makeContext(idle()) as never);
    commandTerminalRestartability.mockReturnValueOnce('restartable');
    expect(deps.terminalRestartability(terminal)).toBe('restartable');
    expect(commandTerminalRestartability).toHaveBeenCalledWith(expect.anything(), 'session-1');
  });

  it('hands the tasks to bring back to the resume path with the context and the map', async () => {
    const context = makeContext(idle());
    const deps = programUpdateSessionDeps(() => context as never);
    const sessionIdsByProject = new Map([['project-1', ['session-1']]]);
    resumeSessionsAfterProgramUpdate.mockResolvedValueOnce(undefined);
    await deps.resumeTasks(sessionIdsByProject as never);
    expect(resumeSessionsAfterProgramUpdate).toHaveBeenCalledWith(context, sessionIdsByProject);
  });
});

describe('the pause it asks for', () => {
  it("is the system's, so recovery brings it back, and is re-checked against the same session under the lock", async () => {
    const deps = programUpdateSessionDeps(() => makeContext(idle()) as never);
    let eligible = true;
    await deps.suspendTask(task, () => eligible);

    expect(pauseTaskSession).toHaveBeenCalledWith(expect.anything(), 'task-1', expect.objectContaining({ projectId: 'project-1', suspendedBy: 'system' }));
    const options = (pauseTaskSession.mock.calls[0] as unknown as [unknown, string, { stillEligible: (session: { id: string }) => boolean }])[2];
    expect(options.stillEligible({ id: 'session-1' })).toBe(true);
    expect(options.stillEligible({ id: 'another-session' })).toBe(false);
    eligible = false;
    expect(options.stillEligible({ id: 'session-1' })).toBe(false);
  });
});
