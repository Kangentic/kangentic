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
import { buildAnswerMcpServer, buildConfiguredMcpServer, buildWorkflowAgentMcpServer, parseMcpRequestPath } from '../../src/main/agent/mcp-http-server';
import { appendAnswerCaller, appendWorkflowAgentCaller, isAnswerCaller, workflowIdOfCaller } from '../../src/main/agent/mcp-http/caller-url';
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
      reserveHoldSlot: () => true,
      dispose: () => {},
      _stateSizesForTesting: () => ({ queues: 0, pending: 0, hops: 0, windows: 0, refusalNotices: 0 }),
    },
    sessions: {
      findLiveSessionByTaskId: () => undefined,
      getSessionTaskId: () => undefined,
      getSessionProjectId: () => undefined,
      isWritable: () => false,
    },
    holdTaskMessage: () => ({ status: 'refused', error: 'unused in this test' }),
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

describe('buildAnswerMcpServer - a Knowledge Graph answer run sees one tool', () => {
  // The probes that qualified each answering CLI used a one-tool server. The
  // real one carries create, move and delete tools, and several CLIs cannot be
  // limited to one MCP tool from outside (Cursor's --force approves every call;
  // OpenCode called an MCP tool without asking). So the server decides.
  it('lists exactly kangentic_search', async () => {
    const server = buildAnswerMcpServer(makeResolver());
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'guard', version: '1.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    await client.close();
    await server.close();

    expect(tools.map((tool) => tool.name)).toEqual(['kangentic_search']);
  });

  it('is what an answer URL routes to, and nothing else is', () => {
    // The URL an answer run is handed must parse back to a caller the server
    // recognizes, or the one-tool server is never selected.
    const url = appendAnswerCaller('http://127.0.0.1:1/mcp/p1', 'chat-7');
    const parsed = parseMcpRequestPath(new URL(url).pathname);
    expect(parsed).toEqual({ projectId: 'p1', callerSessionId: 'answer-chat-7' });
    expect(isAnswerCaller(parsed?.callerSessionId)).toBe(true);

    // A task session's own caller id, and no caller at all, keep the full server.
    expect(isAnswerCaller('0f3c2a1e-session-id')).toBe(false);
    expect(isAnswerCaller(undefined)).toBe(false);
  });
});

describe('buildWorkflowAgentMcpServer - a workflow agent reads, and plans only its own workflow', () => {
  async function listWorkflowAgentTools() {
    const server = buildWorkflowAgentMcpServer(makeResolver(), fakeTaskCounter, 'wf-1');
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'guard', version: '1.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    await client.close();
    await server.close();
    return tools;
  }

  it('lists the read-only tools and the planning tools, and nothing that changes board work', async () => {
    const tools = await listWorkflowAgentTools();
    const names = tools.map((tool) => tool.name);
    for (const kept of ['kangentic_list_tasks', 'kangentic_find_task', 'kangentic_list_columns', 'kangentic_get_workflow', 'kangentic_save_workflow', 'kangentic_link_workflow_tasks', 'kangentic_set_task_route']) {
      expect(names).toContain(kept);
    }
    for (const dropped of ['kangentic_create_task', 'kangentic_move_task', 'kangentic_delete_task', 'kangentic_update_column', 'kangentic_start_workflow', 'kangentic_delete_workflow', 'kangentic_pause_workflow']) {
      expect(names).not.toContain(dropped);
    }
    expect(names.some((name) => name.startsWith('kangentic_browser_'))).toBe(false);
    // Every tool it has is read-only, or one of the planning tools.
    for (const tool of tools) {
      if (tool.annotations?.readOnlyHint === true) continue;
      expect(['kangentic_save_workflow', 'kangentic_add_workflow_task', 'kangentic_link_workflow_tasks', 'kangentic_unlink_workflow_tasks', 'kangentic_set_task_route', 'kangentic_remove_from_workflow', 'kangentic_request_project_access']).toContain(tool.name);
    }
  });

  it('takes `workflow` and `project` off a planning tool, so it needs neither', async () => {
    const tools = await listWorkflowAgentTools();
    const save = tools.find((tool) => tool.name === 'kangentic_save_workflow');
    const properties = (save?.inputSchema.properties ?? {}) as Record<string, unknown>;
    expect(properties).not.toHaveProperty('project');
    expect(save?.inputSchema.required ?? []).not.toContain('workflow');
    const link = tools.find((tool) => tool.name === 'kangentic_link_workflow_tasks');
    expect(link?.inputSchema.required ?? []).not.toContain('workflow');
  });

  describe('its instructions', () => {
    async function readInstructions(): Promise<{ instructions: string; toolNames: string[] }> {
      const server = buildWorkflowAgentMcpServer(makeResolver(), fakeTaskCounter, 'wf-1');
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'guard', version: '1.0.0' });
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const instructions = client.getInstructions() ?? '';
      const { tools } = await client.listTools();
      await client.close();
      await server.close();
      return { instructions, toolNames: tools.map((tool) => tool.name) };
    }

    it('name kangentic_request_project_access as the way to read another project, and defer to its reply', async () => {
      const { instructions, toolNames } = await readInstructions();

      // Claude Code defers MCP tools when there are many, so the agent sees a
      // tool's name and not its description until it searches: the instructions
      // are where it learns what the tool is for.
      expect(instructions).toContain('READING ANOTHER PROJECT');
      expect(instructions).toContain('kangentic_request_project_access');
      expect(instructions).toContain('kangentic_list_projects');
      expect(instructions).toContain('do what its reply says');
      // Any agent can be a workflow's agent now, and only one whose CLI can widen
      // its reads is restarted with the checkout readable, so the instructions do
      // not promise that; the tool's reply says which case applies.
      expect(instructions).not.toContain('then end your turn');
      expect(instructions).not.toContain('comes back on this conversation');
      // ...and the tool it names is one this server registers.
      expect(toolNames).toContain('kangentic_request_project_access');
      // The paragraph is the workflow agent's own, not the shared base text.
      expect(buildServerInstructions(makeResolver(), false)).not.toContain('kangentic_request_project_access');
    });

    it('tell the agent not to search the disk for another project\'s folder', async () => {
      const { instructions } = await readInstructions();

      expect(instructions).toContain('Do not search the disk for another project\'s folder');
    });

    it('keep the shared server rules and the planning scope ahead of the project-access paragraph', async () => {
      const { instructions } = await readInstructions();

      expect(instructions).toContain('PROJECT ROUTING RULE');
      expect(instructions).toContain('You are planning one workflow.');
      expect(instructions.indexOf('You are planning one workflow.')).toBeLessThan(instructions.indexOf('READING ANOTHER PROJECT'));
    });
  });

  it('is what a workflow agent URL routes to', () => {
    const url = appendWorkflowAgentCaller('http://127.0.0.1:1/mcp/p1', 'wf-1');
    const parsed = parseMcpRequestPath(new URL(url ?? '').pathname);
    expect(parsed).toEqual({ projectId: 'p1', callerSessionId: 'workflow-wf-1' });
    expect(workflowIdOfCaller(parsed?.callerSessionId)).toBe('wf-1');
    expect(workflowIdOfCaller('0f3c2a1e-session-id')).toBeNull();
    expect(workflowIdOfCaller('workflow-')).toBeNull();
    expect(workflowIdOfCaller(undefined)).toBeNull();
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
