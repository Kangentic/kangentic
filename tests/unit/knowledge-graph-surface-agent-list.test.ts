/**
 * Pins knowledgeGraphSurface's agent-list subscription
 * (src/renderer/pop-out/surfaces/knowledge-graph-surface.tsx). The ask box
 * decides who answers from the installed agents, and this window loads the list
 * once at a launch, which is the last launch's. Main pushes `agent:listChanged`
 * when its own read of an agent differs, and without this subscription the
 * detached window keeps the stale list until it is reopened.
 *
 * Red-green: drop the `onListChanged` call from bootstrap (the push never lists
 * again), its abort hookup (the unsubscribe never runs), or the channel from
 * POP_OUT_SURFACES['knowledge-graph'].channels (main never sends it here), and
 * the matching test reads red. The Knowledge Graph store and root are mocked
 * away: bootstrap's calls into them are incidental to this subscription.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const agentsListMock = vi.fn();
const agentsOnListChangedMock = vi.fn();
const openMock = vi.fn();
const closeMock = vi.fn();

(globalThis as Record<string, unknown>).window = {
  electronAPI: {
    agents: { list: agentsListMock, onListChanged: agentsOnListChangedMock },
  },
};

vi.mock('../../src/renderer/stores/knowledge-graph-store', () => ({
  useKnowledgeGraphStore: {
    getState: () => ({ open: openMock, close: closeMock }),
  },
}));

vi.mock('../../src/renderer/pop-out/roots/PopOutKnowledgeGraphRoot', () => ({
  PopOutKnowledgeGraphRoot: () => null,
}));

import { useConfigStore } from '../../src/renderer/stores/config-store';
import { knowledgeGraphSurface } from '../../src/renderer/pop-out/surfaces/knowledge-graph-surface';
import { POP_OUT_SURFACES } from '../../src/shared/pop-out';
import { IPC } from '../../src/shared/ipc-channels';

describe('knowledgeGraphSurface bootstrap: agent list changed', () => {
  let controller: AbortController;

  beforeEach(() => {
    vi.clearAllMocks();
    agentsListMock.mockResolvedValue([]);
    agentsOnListChangedMock.mockReturnValue(() => {});
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

    knowledgeGraphSurface.bootstrap({}, { signal: controller.signal });
    expect(agentsOnListChangedMock).toHaveBeenCalledTimes(1);
    expect(agentsListMock).toHaveBeenCalledTimes(1);

    listChanged?.();
    expect(agentsListMock).toHaveBeenCalledTimes(2);
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
    knowledgeGraphSurface.bootstrap({}, { signal: controller.signal });

    const changedAgent = { name: 'claude', found: true, version: '9.9.9' };
    agentsListMock.mockResolvedValue([changedAgent]);
    listChanged?.();

    await vi.waitFor(() => {
      expect(useConfigStore.getState().agentList).toEqual([changedAgent]);
    });
  });

  it('is sent the list-changed push, which the surface must declare to receive', () => {
    expect(POP_OUT_SURFACES['knowledge-graph'].channels).toContain(IPC.AGENT_LIST_CHANGED);
  });
});
