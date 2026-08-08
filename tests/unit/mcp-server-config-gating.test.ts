/**
 * Guards two MCP context-weight optimizations that trim the fixed token cost
 * every spawned agent pays (tool schemas + instructions live in the agent's
 * system prompt):
 *
 *   1. The kangentic_browser_* family (~14 tools, ~3.6k tokens) is registered
 *      ONLY when browser automation is enabled. When it is off, every
 *      CDP-driving tool is already blocked by the withGuest capability gate (and
 *      the one non-gated tool, list_panes, could only report panes the agent
 *      cannot act on), so advertising them is dead context. Red-green: on the
 *      old unconditional path the disabled server still exposes browser tools;
 *      on the gated path it does not.
 *   2. The per-tool `project` selector description is a concise pointer, not the
 *      full routing paragraph repeated on ~28 tools (~4.5k tokens of dup). The
 *      full rule lives once in the server instructions. Red-green: the old
 *      paragraph repeated the phrasing examples per tool; the new one defers
 *      them to the instructions.
 *
 * Heavy leaf modules are stubbed so mcp-http-server imports under node.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({
  webContents: { fromId: () => null },
  app: { getPath: () => '/tmp', isPackaged: false },
}));
vi.mock('../../src/main/agent/commands', () => ({ commandHandlers: {} }));
vi.mock('../../src/main/agent/mcp-project-context', () => ({
  buildCommandContextForProject: vi.fn(() => null),
}));
vi.mock('../../src/main/search/search-core', () => ({ runSearchEverything: vi.fn() }));
vi.mock('../../src/main/diagnostics/process-metrics', () => ({ getProcessMetrics: vi.fn() }));
vi.mock('../../src/main/git/worktree-list', () => ({ enumerateWorktrees: vi.fn() }));
vi.mock('../../src/main/browser/browser-pane-driver', () => ({
  withGuest: vi.fn(),
  validateNavigationUrl: vi.fn(),
}));
vi.mock('../../src/main/browser/browser-pane-registry', () => ({
  browserPaneRegistry: { list: () => [] },
}));
vi.mock('../../src/main/browser/cdp/cdp', () => ({
  clickAtCenterOfSelector: vi.fn(),
  dispatchMouseEvent: vi.fn(),
  dispatchKeyEvent: vi.fn(),
  dispatchKeypress: vi.fn(),
  dragFromTo: vi.fn(),
  getOuterHtml: vi.fn(),
  getBoundingBox: vi.fn(),
  getConsoleEntries: vi.fn(),
  getLayoutMetrics: vi.fn(),
  queryAllElements: vi.fn(),
  runtimeEvaluate: vi.fn(),
  typeText: vi.fn(),
}));
vi.mock('../../src/main/browser/cdp/screenshot', () => ({
  captureScreenshotWithBudget: vi.fn(),
  captureElementClip: vi.fn(),
}));
vi.mock('../../src/devtools/mcp/register', () => ({ registerDevtoolsMcpTools: vi.fn() }));

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildConfiguredMcpServer } from '../../src/main/agent/mcp-http-server';
import { buildServerInstructions } from '../../src/main/agent/mcp-http/server-instructions';
import { PROJECT_SELECTOR_DESCRIPTION, type TaskCounter } from '../../src/main/agent/mcp-http/handler-helpers';
import type { RequestResolver } from '../../src/main/agent/mcp-http/project-resolver';
import type { ResolvedBrowserAutomationConfig } from '../../src/main/browser/browser-automation-config';
import type { SteeringToolDependencies } from '../../src/main/agent/mcp-http/steering-tools';

function makeResolver(): RequestResolver {
  return {
    listProjects: () => [
      { id: 'p1', name: 'Alpha', path: '/p1', lastOpened: '2026-01-01T00:00:00.000Z', isActive: true },
    ],
    resolveProject: () => ({ error: 'unused in this test' }),
  } as unknown as RequestResolver;
}

const fakeTaskCounter: TaskCounter = { tryReserve: () => true, limit: () => 100 };

function configReader(enabled: boolean): () => ResolvedBrowserAutomationConfig {
  return () => ({
    enabled,
    allowInteraction: true,
    allowNavigation: true,
    allowEval: false,
    restrictNavigationToLocalhost: false,
  });
}

/** Build a configured server and read its advertised tool names via the public client API. */
async function listToolNames(
  browserEnabled: boolean,
  steering?: SteeringToolDependencies | null,
): Promise<string[]> {
  const server = buildConfiguredMcpServer(
    makeResolver(),
    fakeTaskCounter,
    configReader(browserEnabled),
    steering,
    // Caller scope for the browser family. Required, so a server can never be
    // built with unscoped browser tools; the scoping behavior itself is covered
    // by mcp-browser-tools-project-scope.test.ts.
    { projectId: 'p1' },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'guard', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const { tools } = await client.listTools();
  await client.close();
  await server.close();
  return tools.map((tool) => tool.name);
}

/** A minimal, valid SteeringToolDependencies stub - only the shape matters for gating. */
function fakeSteeringDependencies(): SteeringToolDependencies {
  return {
    coordinator: {
      send: async () => ({ error: 'unused in this test' }),
      dispose: () => {},
      _stateSizesForTesting: () => ({ queues: 0, pending: 0, hops: 0, windows: 0, refusalNotices: 0 }),
    },
    sessions: {
      findLiveSessionByTaskId: () => undefined,
      getSessionTaskId: () => undefined,
      getSessionProjectId: () => undefined,
    },
  };
}

describe('buildConfiguredMcpServer - browser tool gating', () => {
  it('registers the kangentic_browser_* family when browser automation is enabled', async () => {
    const names = await listToolNames(true);
    expect(names.some((name) => name.startsWith('kangentic_browser_'))).toBe(true);
    // Core tools are always present.
    expect(names).toContain('kangentic_create_task');
  });

  it('omits the kangentic_browser_* family when browser automation is disabled', async () => {
    const enabled = await listToolNames(true);
    const disabled = await listToolNames(false);

    expect(disabled.some((name) => name.startsWith('kangentic_browser_'))).toBe(false);
    // Disabling browser automation drops ONLY the browser family - nothing else.
    expect(disabled).toContain('kangentic_create_task');
    const browserCount = enabled.filter((name) => name.startsWith('kangentic_browser_')).length;
    expect(browserCount).toBeGreaterThan(0);
    expect(enabled.length - disabled.length).toBe(browserCount);
  });
});

describe('project-selector description dedup', () => {
  it('is a concise pointer and defers the phrasing examples to the server instructions', () => {
    // The repeated routing paragraph (with "X's backlog" et al.) must NOT be
    // duplicated onto every project-aware tool.
    expect(PROJECT_SELECTOR_DESCRIPTION).not.toContain("X's backlog");
    expect(PROJECT_SELECTOR_DESCRIPTION.length).toBeLessThan(420);
    // ...but the full routing rule (examples included) must still exist exactly
    // once, in the server instructions that ride in every agent's system prompt.
    const instructions = buildServerInstructions(makeResolver());
    expect(instructions).toContain('PROJECT ROUTING RULE');
    expect(instructions).toContain("X's backlog");
  });
});

describe('buildConfiguredMcpServer - steering tool gating', () => {
  // Coverage hole: registerSteeringTools is called only `if (steering)`
  // (mcp-http-server.ts's buildConfiguredMcpServer). Every browser-gating test
  // above calls buildConfiguredMcpServer with the `steering` argument omitted,
  // so a regression that registered the steering tools unconditionally (or
  // never registered them at all) would fail nothing above.
  it('registers the steering tools when a truthy steering dependency is passed', async () => {
    const names = await listToolNames(true, fakeSteeringDependencies());

    // Red: wrapping registerSteeringTools's call site in `if (false)` (or
    // deleting the call) makes these absent even with steering supplied.
    expect(names).toContain('kangentic_send_session_message');
    expect(names).toContain('kangentic_get_session_messages_sent');
  });

  it('omits the steering tools when steering is undefined (IPC context not ready yet)', async () => {
    const names = await listToolNames(true, undefined);

    expect(names).not.toContain('kangentic_send_session_message');
    expect(names).not.toContain('kangentic_get_session_messages_sent');
    // Confirms the omission is scoped to steering, not a broken server.
    expect(names).toContain('kangentic_create_task');
  });

  it('omits the steering tools when steering is explicitly null', async () => {
    // Red: removing the `if (steering)` guard entirely (calling
    // registerSteeringTools unconditionally) would crash on a null
    // `dependencies.coordinator` before this assertion, or - if guarded only
    // against undefined - register the tools here when it should not.
    const names = await listToolNames(true, null);

    expect(names).not.toContain('kangentic_send_session_message');
    expect(names).not.toContain('kangentic_get_session_messages_sent');
  });
});
