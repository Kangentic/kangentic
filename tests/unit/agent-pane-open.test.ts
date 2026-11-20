/**
 * applyAgentPaneOpen (src/renderer/utils/agent-pane-open.ts) against the real session store:
 * how an agent's open_pane push sets a Browser pane's open state by its purpose.
 * What a user loses if this goes: an agent's own scratch browsing pops a pane over their
 * terminal, or a pane the agent was asked to show them stays hidden.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { useSessionStore } from '../../src/renderer/stores/session-store';
import { applyAgentPaneOpen } from '../../src/renderer/utils/agent-pane-open';

const OWNER_KEY = 'task-1';

beforeEach(() => {
  useSessionStore.setState({
    browserOpenTasks: new Set(),
    browserHeldTasks: new Set(),
  });
});

describe('applyAgentPaneOpen', () => {
  it('own-work with the pane not open mounts it held, not open', () => {
    applyAgentPaneOpen(OWNER_KEY, 'own-work');

    const state = useSessionStore.getState();
    expect(state.browserOpenTasks.has(OWNER_KEY)).toBe(false);
    expect(state.browserHeldTasks.has(OWNER_KEY)).toBe(true);
  });

  it('own-work with the pane already open leaves it open and touches nothing', () => {
    useSessionStore.getState().setBrowserOpen(OWNER_KEY, true);
    const before = useSessionStore.getState();

    applyAgentPaneOpen(OWNER_KEY, 'own-work');

    const after = useSessionStore.getState();
    expect(after.browserOpenTasks.has(OWNER_KEY)).toBe(true);
    expect(after.browserHeldTasks.has(OWNER_KEY)).toBe(false);
    expect(after.browserOpenTasks).toBe(before.browserOpenTasks);
    expect(after.browserHeldTasks).toBe(before.browserHeldTasks);
  });

  it('for-user opens the pane and ends a hold', () => {
    useSessionStore.getState().setBrowserOpen(OWNER_KEY, false, { hold: true });
    expect(useSessionStore.getState().browserHeldTasks.has(OWNER_KEY)).toBe(true);

    applyAgentPaneOpen(OWNER_KEY, 'for-user');

    const state = useSessionStore.getState();
    expect(state.browserOpenTasks.has(OWNER_KEY)).toBe(true);
    expect(state.browserHeldTasks.has(OWNER_KEY)).toBe(false);
  });

  it('an absent purpose behaves like for-user', () => {
    useSessionStore.getState().setBrowserOpen(OWNER_KEY, false, { hold: true });

    applyAgentPaneOpen(OWNER_KEY, undefined);

    const state = useSessionStore.getState();
    expect(state.browserOpenTasks.has(OWNER_KEY)).toBe(true);
    expect(state.browserHeldTasks.has(OWNER_KEY)).toBe(false);
  });
});
