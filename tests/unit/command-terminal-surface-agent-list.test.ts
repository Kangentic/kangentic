/**
 * Pins commandTerminalSurface's agent-list subscription
 * (src/renderer/pop-out/surfaces/command-terminal-surface.tsx). The detached
 * Command Terminal's model and effort pickers read the agent list its root
 * loads once, which is the last launch's. Main pushes `agent:listChanged` when
 * its own read of an agent differs, and without this subscription the window
 * keeps the stale list until it is reopened.
 *
 * Red-green: drop the `onListChanged` entry from bootstrap's subscriber list
 * (the push never lists again), or the channel from
 * POP_OUT_SURFACES['command-terminal'].channels (main never sends it here), and
 * the matching test reads red. Abort runs every subscriber's unsubscribe, so
 * the agent-list one returns a spy of its own and the others return plain
 * functions. The session store and root are mocked away: bootstrap's other
 * subscriptions are incidental to this one.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const agentsListMock = vi.fn();
const agentsOnListChangedMock = vi.fn();
const sessionPushMocks = {
  onStatus: vi.fn(),
  onRemoved: vi.fn(),
  onExit: vi.fn(),
  onFirstOutput: vi.fn(),
  onUsage: vi.fn(),
  onActivity: vi.fn(),
};
const loadBrowserOffscreenTasksMock = vi.fn();
const loadBrowserCrashedTasksMock = vi.fn();

(globalThis as Record<string, unknown>).window = {
  electronAPI: {
    agents: { list: agentsListMock, onListChanged: agentsOnListChangedMock },
    sessions: sessionPushMocks,
  },
};

vi.mock('../../src/renderer/stores/session-store', () => ({
  useSessionStore: {
    getState: () => ({
      loadBrowserOffscreenTasks: loadBrowserOffscreenTasksMock,
      loadBrowserCrashedTasks: loadBrowserCrashedTasksMock,
      sessions: [],
    }),
  },
}));

vi.mock('../../src/renderer/pop-out/roots/PopOutCommandTerminalRoot', () => ({
  PopOutCommandTerminalRoot: () => null,
}));

import { useConfigStore } from '../../src/renderer/stores/config-store';
import { commandTerminalSurface } from '../../src/renderer/pop-out/surfaces/command-terminal-surface';
import { POP_OUT_SURFACES } from '../../src/shared/pop-out';
import { IPC } from '../../src/shared/ipc-channels';

describe('commandTerminalSurface bootstrap: agent list changed', () => {
  let controller: AbortController;

  beforeEach(() => {
    vi.clearAllMocks();
    for (const pushMock of Object.values(sessionPushMocks)) pushMock.mockReturnValue(() => {});
    agentsListMock.mockResolvedValue([]);
    agentsOnListChangedMock.mockReturnValue(() => {});
    loadBrowserOffscreenTasksMock.mockResolvedValue(undefined);
    loadBrowserCrashedTasksMock.mockResolvedValue(undefined);
    useConfigStore.setState({ agentList: [], agentListLoaded: false });
    controller = new AbortController();
  });

  afterEach(() => {
    controller.abort();
  });

  it('lists the agents again when main says the list changed, and stops listening on abort', async () => {
    let listChanged: (() => void) | undefined;
    const unsubscribe = vi.fn();
    agentsOnListChangedMock.mockImplementation((callback: () => void) => {
      listChanged = callback;
      return unsubscribe;
    });

    commandTerminalSurface.bootstrap({}, { signal: controller.signal });
    expect(agentsOnListChangedMock).toHaveBeenCalledTimes(1);
    // The root loads the first list, so bootstrap itself lists nothing.
    expect(agentsListMock).not.toHaveBeenCalled();

    listChanged?.();
    expect(agentsListMock).toHaveBeenCalledTimes(1);
    expect(unsubscribe).not.toHaveBeenCalled();

    controller.abort();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    await Promise.resolve();
  });

  it('puts the re-listed agents into the config store', async () => {
    let listChanged: (() => void) | undefined;
    agentsOnListChangedMock.mockImplementation((callback: () => void) => {
      listChanged = callback;
      return () => {};
    });
    commandTerminalSurface.bootstrap({}, { signal: controller.signal });

    const changedAgent = { name: 'claude', found: true, version: '9.9.9' };
    agentsListMock.mockResolvedValue([changedAgent]);
    listChanged?.();

    await vi.waitFor(() => {
      expect(useConfigStore.getState().agentList).toEqual([changedAgent]);
    });
  });

  it('is sent the list-changed push, which the surface must declare to receive', () => {
    expect(POP_OUT_SURFACES['command-terminal'].channels).toContain(IPC.AGENT_LIST_CHANGED);
  });
});
