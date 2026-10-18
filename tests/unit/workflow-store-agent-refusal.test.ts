/**
 * What the workflow store remembers of main's last refusal to start a workflow's
 * agent, driven straight through the real store with a hand-held bridge.
 *
 * An open or resume answers with a session, or with a refusal of one of two
 * kinds: `unavailable` (a reason written for the user: the MCP server is off, the
 * CLI is gone) and `setupNeeded` (the Workflow agent setting is not complete, so
 * the pane asks for it). Each answer replaces the last one for its workflow, and
 * `clearAgentRefusal` forgets both kinds once the user has been to Settings, where
 * most reasons are fixed, so the pane may try again. A clear with nothing to
 * forget writes nothing, because every pane subscribed to those maps would render
 * for no reason.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Session, WorkflowAgentStatus } from '../../src/shared/types';

const harness = vi.hoisted(() => ({
  upsertSession: vi.fn(),
}));
vi.mock('../../src/renderer/stores/project-store', () => ({
  useProjectStore: { getState: () => ({ currentProject: { id: 'p' } }) },
}));
vi.mock('../../src/renderer/stores/toast-store', () => ({
  useToastStore: { getState: () => ({ addToast: vi.fn() }) },
}));
vi.mock('../../src/renderer/stores/session-store', () => ({
  useSessionStore: { getState: () => ({ upsertSession: harness.upsertSession }) },
}));

const { useWorkflowStore } = await import('../../src/renderer/stores/workflow-store');

const state = () => useWorkflowStore.getState();

interface WorkflowsBridge {
  agentOpen: ReturnType<typeof vi.fn>;
  agentResume: ReturnType<typeof vi.fn>;
}

function installBridge(): WorkflowsBridge {
  const workflows: WorkflowsBridge = { agentOpen: vi.fn(), agentResume: vi.fn() };
  (globalThis as unknown as { window: { electronAPI: { workflows: WorkflowsBridge } } }).window = {
    electronAPI: { workflows },
  };
  return workflows;
}

/** A row with only what the store reads of it: it hands the row on to the session store untouched. */
const runningAgent = { id: 'agent-session', workflowId: 'w', status: 'running' } as unknown as Session;

const REFUSAL_REASON = 'The workflow agent works through Kangentic\'s MCP server, which is off. Turn it on in Settings, MCP Server.';

const answers: Record<'session' | 'setupNeeded' | 'unavailable' | 'startsOnRequest', WorkflowAgentStatus> = {
  session: { session: runningAgent, unavailable: null, setupNeeded: false, startsOnRequest: false },
  setupNeeded: { session: null, unavailable: null, setupNeeded: true, startsOnRequest: false },
  unavailable: { session: null, unavailable: REFUSAL_REASON, setupNeeded: false, startsOnRequest: false },
  startsOnRequest: { session: null, unavailable: null, setupNeeded: false, startsOnRequest: true },
};

beforeEach(() => {
  harness.upsertSession.mockClear();
  useWorkflowStore.setState({
    projectId: 'p',
    selectedWorkflowId: 'w',
    agentUnavailable: {},
    agentSetupNeeded: {},
    agentStartsOnRequest: {},
  });
});

// The pane's open and its Resume both show what main answered the same way.
describe.each([
  { action: 'openAgent', bridgeMethod: 'agentOpen' },
  { action: 'resumeAgent', bridgeMethod: 'agentResume' },
] as const)('$action', ({ action, bridgeMethod }) => {
  it('remembers that the Workflow agent setting is not complete, and no other refusal', async () => {
    const bridge = installBridge();
    bridge[bridgeMethod].mockResolvedValue(answers.setupNeeded);

    await state()[action]();

    expect(bridge[bridgeMethod]).toHaveBeenCalledWith('p', 'w', undefined, undefined);
    expect(state().agentSetupNeeded).toEqual({ w: true });
    expect(state().agentUnavailable).toEqual({});
    expect(harness.upsertSession).not.toHaveBeenCalled();
  });

  it('forgets a setup refusal when the next answer is a session, and shows that session', async () => {
    const bridge = installBridge();
    bridge[bridgeMethod].mockResolvedValueOnce(answers.setupNeeded).mockResolvedValueOnce(answers.session);
    await state()[action]();
    expect(state().agentSetupNeeded).toEqual({ w: true });

    await state()[action]();

    expect(state().agentSetupNeeded).toEqual({});
    expect(state().agentUnavailable).toEqual({});
    expect(harness.upsertSession).toHaveBeenCalledWith(runningAgent);
  });

  it('remembers the reason an agent cannot run, and no setup refusal', async () => {
    const bridge = installBridge();
    bridge[bridgeMethod].mockResolvedValue(answers.unavailable);

    await state()[action]();

    expect(state().agentUnavailable).toEqual({ w: REFUSAL_REASON });
    expect(state().agentSetupNeeded).toEqual({});
  });

  it('forgets a reason when the next answer is a session', async () => {
    const bridge = installBridge();
    bridge[bridgeMethod].mockResolvedValueOnce(answers.unavailable).mockResolvedValueOnce(answers.session);
    await state()[action]();
    expect(state().agentUnavailable).toEqual({ w: REFUSAL_REASON });

    await state()[action]();

    expect(state().agentUnavailable).toEqual({});
  });

  it('replaces one kind of refusal with the other, so the pane shows only the latest', async () => {
    const bridge = installBridge();
    bridge[bridgeMethod]
      .mockResolvedValueOnce(answers.setupNeeded)
      .mockResolvedValueOnce(answers.unavailable)
      .mockResolvedValueOnce(answers.setupNeeded);

    await state()[action]();
    expect(state().agentSetupNeeded).toEqual({ w: true });
    expect(state().agentUnavailable).toEqual({});

    await state()[action]();
    expect(state().agentUnavailable).toEqual({ w: REFUSAL_REASON });
    expect(state().agentSetupNeeded).toEqual({});

    await state()[action]();
    expect(state().agentSetupNeeded).toEqual({ w: true });
    expect(state().agentUnavailable).toEqual({});
  });

  // A workflow another session created opens with nothing started, and the
  // pane offers Ask for changes; that press answers with a session.
  it('remembers an open that started nothing for a plan no agent has seen, and no refusal', async () => {
    const bridge = installBridge();
    bridge[bridgeMethod].mockResolvedValue(answers.startsOnRequest);

    await state()[action]();

    expect(state().agentStartsOnRequest).toEqual({ w: true });
    expect(state().agentSetupNeeded).toEqual({});
    expect(state().agentUnavailable).toEqual({});
    expect(harness.upsertSession).not.toHaveBeenCalled();
  });

  it('forgets that nothing started when the next answer is a session', async () => {
    const bridge = installBridge();
    useWorkflowStore.setState({ agentStartsOnRequest: { other: true } });
    bridge[bridgeMethod].mockResolvedValueOnce(answers.startsOnRequest).mockResolvedValueOnce(answers.session);
    await state()[action]();
    expect(state().agentStartsOnRequest).toEqual({ other: true, w: true });

    await state()[action]();

    expect(state().agentStartsOnRequest).toEqual({ other: true });
    expect(harness.upsertSession).toHaveBeenCalledWith(runningAgent);
  });

  it('keeps another workflow\'s refusal when this one is answered', async () => {
    const bridge = installBridge();
    useWorkflowStore.setState({ agentUnavailable: { other: REFUSAL_REASON }, agentSetupNeeded: { other: true } });
    bridge[bridgeMethod].mockResolvedValue(answers.session);

    await state()[action]();

    expect(state().agentUnavailable).toEqual({ other: REFUSAL_REASON });
    expect(state().agentSetupNeeded).toEqual({ other: true });
  });
});

describe('clearAgentRefusal', () => {
  it.each([
    { name: 'a setup refusal', unavailable: {}, setupNeeded: { w: true as const } },
    { name: 'an unavailable reason', unavailable: { w: REFUSAL_REASON }, setupNeeded: {} },
    { name: 'both kinds', unavailable: { w: REFUSAL_REASON }, setupNeeded: { w: true as const } },
  ])('forgets $name for the workflow', ({ unavailable, setupNeeded }) => {
    useWorkflowStore.setState({ agentUnavailable: unavailable, agentSetupNeeded: setupNeeded });

    state().clearAgentRefusal('w');

    expect(state().agentUnavailable).toEqual({});
    expect(state().agentSetupNeeded).toEqual({});
  });

  it('leaves another workflow\'s refusals alone', () => {
    useWorkflowStore.setState({
      agentUnavailable: { w: REFUSAL_REASON, other: 'Kangentic cannot find Claude Code on this machine.' },
      agentSetupNeeded: { w: true, other: true },
    });

    state().clearAgentRefusal('w');

    expect(state().agentUnavailable).toEqual({ other: 'Kangentic cannot find Claude Code on this machine.' });
    expect(state().agentSetupNeeded).toEqual({ other: true });
  });

  it('writes nothing for a workflow with no refusal: the same objects, and no subscriber told', () => {
    useWorkflowStore.setState({
      agentUnavailable: { other: REFUSAL_REASON },
      agentSetupNeeded: { other: true },
    });
    const unavailableBefore = state().agentUnavailable;
    const setupNeededBefore = state().agentSetupNeeded;
    const subscriber = vi.fn();
    const unsubscribe = useWorkflowStore.subscribe(subscriber);
    try {
      state().clearAgentRefusal('w');
    } finally {
      unsubscribe();
    }

    expect(state().agentUnavailable).toBe(unavailableBefore);
    expect(state().agentSetupNeeded).toBe(setupNeededBefore);
    expect(subscriber).not.toHaveBeenCalled();
  });
});
