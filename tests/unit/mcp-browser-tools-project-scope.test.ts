/**
 * Guards the cross-project isolation of the kangentic_browser_* family.
 *
 * The bug this exists to prevent: an agent in one project drove the Browser
 * pane belonging to a task in ANOTHER project, because `selectorFrom` built a
 * selector out of the agent's own arguments only and `resolveTarget` fell back
 * to "the single open pane" across a process-wide registry. Caller identity
 * (the `/mcp/<projectId>/<callerSessionId>` URL path) already existed and was
 * simply never handed to this tool family.
 *
 * The load-bearing case is the FIRST one: it enumerates the registered tools at
 * runtime and fails when a tool has no entry in MINIMAL_ARGS, so a newly added
 * browser tool cannot ship without a deliberate decision about its scoping. A
 * static scan over browser-tools.ts would drift; this cannot.
 *
 * withGuest is stubbed as a capturing spy so the selector each tool builds is
 * observable without any CDP, guest, or Electron involvement.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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
// Every tool is driven through a stubbed withGuest that returns a benign error
// envelope. The envelope shape is uniform across all 13 tools (a success
// payload is not: screenshots, DOM reads and clicks each shape their own), and
// what these tests assert is the SELECTOR withGuest was handed, not the body.
vi.mock('../../src/main/browser/browser-pane-driver', () => ({
  withGuest: vi.fn(async () => ({ ok: false, error: { kind: 'stubbed', detail: 'stubbed' } })),
  validateNavigationUrl: vi.fn((url: string) => ({ ok: true, url })),
}));
vi.mock('../../src/main/browser/browser-pane-registry', () => ({
  browserPaneRegistry: {
    list: vi.fn(() => []),
    listForProject: vi.fn(() => ({
      panes: [],
      otherProjectPaneCount: 0,
      unknownProjectPaneCount: 0,
    })),
  },
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
import { withGuest } from '../../src/main/browser/browser-pane-driver';
import { browserPaneRegistry } from '../../src/main/browser/browser-pane-registry';
import type { TaskCounter } from '../../src/main/agent/mcp-http/handler-helpers';
import type { RequestResolver } from '../../src/main/agent/mcp-http/project-resolver';
import type { ResolvedBrowserAutomationConfig } from '../../src/main/browser/browser-automation-config';
import type {
  BrowserToolDependencies,
  BrowserSessionLookup,
} from '../../src/main/agent/mcp-http/browser-tools';
import type { ResolveTargetSelector } from '../../src/main/browser/browser-pane-registry';

const CALLER_PROJECT = 'p1';

function makeResolver(): RequestResolver {
  return {
    listProjects: () => [
      { id: CALLER_PROJECT, name: 'Alpha', path: '/p1', lastOpened: '2026-01-01T00:00:00.000Z', isActive: true },
    ],
    resolveProject: () => ({ error: 'unused in this test' }),
  } as unknown as RequestResolver;
}

const fakeTaskCounter: TaskCounter = { tryReserve: () => true, limit: () => 100 };

function automationConfig(): ResolvedBrowserAutomationConfig {
  return {
    enabled: true,
    allowInteraction: true,
    allowNavigation: true,
    allowEval: true,
    restrictNavigationToLocalhost: false,
  };
}

/**
 * Minimal valid arguments per tool, so every registered tool can actually be
 * invoked. `null` marks the ONE tool that legitimately does not route through
 * withGuest (see .claude/rules/browser-automation-driver.md).
 */
const MINIMAL_ARGS: Record<string, Record<string, unknown> | null> = {
  kangentic_browser_list_panes: null,
  kangentic_browser_navigate: { url: 'http://localhost:1' },
  kangentic_browser_screenshot: {},
  kangentic_browser_screenshot_element: { selector: 'body' },
  kangentic_browser_query_dom: {},
  kangentic_browser_query_all: { selector: 'body' },
  kangentic_browser_bounding_box: { selector: 'body' },
  kangentic_browser_console: {},
  kangentic_browser_wait: { selector: 'body', timeoutMs: 1, intervalMs: 1 },
  kangentic_browser_click: {},
  kangentic_browser_type: { text: 'x' },
  kangentic_browser_keypress: { keys: 'Enter' },
  kangentic_browser_drag: { fromSelector: 'a', toSelector: 'b' },
  kangentic_browser_eval: { expression: '1' },
};

async function connect(browser: BrowserToolDependencies) {
  const server = buildConfiguredMcpServer(
    makeResolver(),
    fakeTaskCounter,
    automationConfig,
    null,
    browser,
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'scope-guard', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

/** The selector the most recent withGuest call was given. */
function lastSelector(): ResolveTargetSelector {
  const calls = vi.mocked(withGuest).mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][0].selector;
}

describe('kangentic_browser_* caller scoping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(withGuest).mockImplementation(async () => ({
      ok: false,
      error: { kind: 'stubbed', detail: 'stubbed' },
    }));
    vi.mocked(browserPaneRegistry.list).mockReturnValue([]);
    vi.mocked(browserPaneRegistry.listForProject).mockReturnValue({
      panes: [],
      otherProjectPaneCount: 0,
      unknownProjectPaneCount: 0,
    });
  });

  it('scopes EVERY registered driving tool to the caller project', async () => {
    const { client, close } = await connect({ projectId: CALLER_PROJECT });
    const { tools } = await client.listTools();
    const browserTools = tools.filter((tool) => tool.name.startsWith('kangentic_browser_'));
    expect(browserTools.length).toBeGreaterThan(0);

    for (const tool of browserTools) {
      // A new browser tool with no entry here fails the suite rather than
      // silently shipping unscoped. Add it to MINIMAL_ARGS deliberately.
      expect(
        Object.prototype.hasOwnProperty.call(MINIMAL_ARGS, tool.name),
        `${tool.name} has no MINIMAL_ARGS entry: decide its caller scoping before it ships`,
      ).toBe(true);
      const args = MINIMAL_ARGS[tool.name];
      if (args === null) continue; // list_panes: registry read only, no withGuest
      vi.mocked(withGuest).mockClear();
      await client.callTool({ name: tool.name, arguments: args });
      expect(lastSelector().projectId, `${tool.name} did not scope its selector`).toBe(
        CALLER_PROJECT,
      );
    }
    await close();
  });

  it('exposes no `project` argument, so no tool can opt out of its scope', async () => {
    const { client, close } = await connect({ projectId: CALLER_PROJECT });
    const { tools } = await client.listTools();
    for (const tool of tools.filter((candidate) => candidate.name.startsWith('kangentic_browser_'))) {
      const properties = (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
      expect(Object.keys(properties), `${tool.name} must not take a project selector`).not.toContain(
        'project',
      );
    }
    await close();
  });

  it('keeps the caller scope when an explicit taskId is passed', async () => {
    const { client, close } = await connect({ projectId: CALLER_PROJECT });
    await client.callTool({
      name: 'kangentic_browser_screenshot',
      arguments: { taskId: 'someone-elses-task' },
    });
    expect(lastSelector()).toMatchObject({
      projectId: CALLER_PROJECT,
      taskId: 'someone-elses-task',
    });
    await close();
  });

  it("threads the caller's own session and task into the selector", async () => {
    const sessions: BrowserSessionLookup = { getSessionTaskId: vi.fn(() => 'task-caller') };
    const { client, close } = await connect({
      projectId: CALLER_PROJECT,
      callerSessionId: 'sess-caller',
      sessions,
    });
    await client.callTool({ name: 'kangentic_browser_screenshot', arguments: {} });
    expect(lastSelector()).toMatchObject({
      projectId: CALLER_PROJECT,
      callerSessionId: 'sess-caller',
      callerTaskId: 'task-caller',
    });
    await close();
  });

  it('resolves the caller task once per request, not once per tool call', async () => {
    const getSessionTaskId = vi.fn(() => 'task-caller');
    const { client, close } = await connect({
      projectId: CALLER_PROJECT,
      callerSessionId: 'sess-caller',
      sessions: { getSessionTaskId },
    });
    await client.callTool({ name: 'kangentic_browser_screenshot', arguments: {} });
    await client.callTool({ name: 'kangentic_browser_console', arguments: {} });
    expect(getSessionTaskId).toHaveBeenCalledTimes(1);
    await close();
  });

  it('degrades rather than refusing when the caller has no session segment', async () => {
    const { client, close } = await connect({ projectId: CALLER_PROJECT });
    // The call still reaches the driver (no pre-resolution refusal) and simply
    // carries no caller preference, so resolution falls back to the single pane
    // open in this project.
    await client.callTool({ name: 'kangentic_browser_screenshot', arguments: {} });
    expect(vi.mocked(withGuest)).toHaveBeenCalled();
    expect(lastSelector()).toMatchObject({ projectId: CALLER_PROJECT });
    expect(lastSelector().callerSessionId).toBeUndefined();
    expect(lastSelector().callerTaskId).toBeUndefined();
    await close();
  });

  it('degrades when the session lookup is unavailable but the URL segment is not', async () => {
    const { client, close } = await connect({
      projectId: CALLER_PROJECT,
      callerSessionId: 'sess-caller',
      sessions: null,
    });
    await client.callTool({ name: 'kangentic_browser_screenshot', arguments: {} });
    expect(lastSelector().callerSessionId).toBe('sess-caller');
    expect(lastSelector().callerTaskId).toBeUndefined();
    await close();
  });

  it('lists only the caller project by default, and reports what it withheld', async () => {
    vi.mocked(browserPaneRegistry.listForProject).mockReturnValue({
      panes: [{ sessionId: 'sess-a', taskId: 'task-1', projectId: CALLER_PROJECT, webContentsId: 11, url: 'http://localhost:4200', registeredAt: 0, alive: true, debuggerAttached: false }],
      otherProjectPaneCount: 2,
      unknownProjectPaneCount: 1,
    });
    const { client, close } = await connect({ projectId: CALLER_PROJECT });
    // buildServerInstructions reads the registry too, so clear that call before
    // asserting the tool itself never reaches the unscoped list().
    vi.mocked(browserPaneRegistry.list).mockClear();
    const result = await client.callTool({ name: 'kangentic_browser_list_panes', arguments: {} });
    const payload = result.structuredContent as {
      projectId: string;
      panes: { sessionId: string; sameProject: boolean; driveable: boolean }[];
      otherProjectPaneCount: number;
      unknownProjectPaneCount: number;
    };
    expect(payload.projectId).toBe(CALLER_PROJECT);
    expect(payload.panes.map((pane) => pane.sessionId)).toEqual(['sess-a']);
    expect(payload.panes[0]).toMatchObject({ sameProject: true, driveable: true });
    expect(payload.otherProjectPaneCount).toBe(2);
    expect(payload.unknownProjectPaneCount).toBe(1);
    expect(vi.mocked(browserPaneRegistry.list)).not.toHaveBeenCalled();
    await close();
  });

  it('lists other projects on request, tagged as not driveable', async () => {
    vi.mocked(browserPaneRegistry.list).mockReturnValue([
      { sessionId: 'sess-a', taskId: 'task-1', projectId: CALLER_PROJECT, webContentsId: 11, url: null, registeredAt: 0, alive: true, debuggerAttached: false },
      { sessionId: 'sess-c', taskId: 'task-3', projectId: 'p2', webContentsId: 33, url: null, registeredAt: 0, alive: true, debuggerAttached: false },
    ]);
    const { client, close } = await connect({ projectId: CALLER_PROJECT });
    const result = await client.callTool({
      name: 'kangentic_browser_list_panes',
      arguments: { includeOtherProjects: true },
    });
    const payload = result.structuredContent as {
      panes: { sessionId: string; sameProject: boolean; driveable: boolean }[];
    };
    expect(payload.panes.map((pane) => pane.sessionId)).toEqual(['sess-a', 'sess-c']);
    expect(payload.panes[1]).toMatchObject({ sameProject: false, driveable: false });
    await close();
  });
});
