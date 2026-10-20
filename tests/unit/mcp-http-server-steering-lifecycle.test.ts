/**
 * Guards two lifecycle properties of the lazily-built SessionSendCoordinator
 * inside startMcpHttpServer/resolveSteering (src/main/agent/mcp-http-server.ts):
 *
 *   1. `close()` must detach the coordinator's SessionManager listeners
 *      (`sessionSendCoordinator?.dispose()`) BEFORE the socket teardown, so a
 *      shutdown never leaves a live 'activity'/'exit' subscriber pointing at a
 *      disposed server. Deleting those lines fails nothing today - no
 *      existing test ever builds a real coordinator through a real server
 *      launch and then closes it.
 *   2. `resolveSteering` builds the coordinator ONCE per server launch (the
 *      `if (!sessionSendCoordinator)` guard) and reuses it across requests, so
 *      its rate-limit windows and hop depths persist for the life of the
 *      launch. Removing that guard would rebuild (and re-subscribe) a fresh
 *      coordinator on every request, which fails nothing today either - no
 *      existing test issues two requests against one running server and
 *      checks the coordinator was not rebuilt.
 *
 * Both are observed indirectly via the fake SessionManager's listener count:
 * the coordinator subscribes exactly one 'activity' and one 'exit' listener
 * per construction, so listener count is a faithful proxy for "was a
 * coordinator built" without reaching into module-private state.
 *
 * Heavy leaf modules are stubbed so mcp-http-server imports under node
 * (mirrors mcp-server-config-gating.test.ts / mcp-server-network-config.test.ts).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import * as http from 'node:http';

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

import { startMcpHttpServer, type McpHttpServerHandle, type McpSteeringContext } from '../../src/main/agent/mcp-http-server';
import { RequestResolver } from '../../src/main/agent/mcp-http/project-resolver';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import type { CommandContext } from '../../src/main/agent/commands/types';

/**
 * Minimal fake for the `sessionManager` slice `McpSteeringContext` requires
 * (`SessionSendSessionManager & SteeringSessionLookup &
 * BackgroundShellServiceMarker`), with listener-count tracking so we can
 * observe how many times the coordinator subscribed/unsubscribed without
 * reaching into mcp-http-server's private state.
 */
function createFakeSteeringSessionManager() {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  return {
    markBackgroundShellsAsServices: vi.fn((_sessionId: string, shellIds: readonly string[]) =>
      shellIds.map((shellId) => ({ shellId, outcome: 'marked' as const }))),
    isWritable: () => false,
    getActivityCache: () => ({}),
    findLiveSessionByTaskId: () => undefined,
    getSessionTaskId: () => undefined,
    getSessionProjectId: () => undefined,
    on(event: string, listener: (...args: unknown[]) => void) {
      const existing = listeners.get(event) ?? [];
      existing.push(listener);
      listeners.set(event, existing);
      return this;
    },
    off(event: string, listener: (...args: unknown[]) => void) {
      listeners.set(event, (listeners.get(event) ?? []).filter((candidate) => candidate !== listener));
      return this;
    },
    listenerCount(event: string) {
      return (listeners.get(event) ?? []).length;
    },
  };
}

function makeResolver(): RequestResolver {
  const fakeIpcContext = { projectRepo: { list: () => [] } } as unknown as IpcContext;
  const fakeCommandContext = {} as unknown as CommandContext;
  return new RequestResolver({
    ipcContext: fakeIpcContext,
    defaultContext: fakeCommandContext,
    defaultProjectId: 'proj-1',
    defaultProjectName: 'Test Project',
  });
}

/**
 * Sends a POST that reaches `resolveSteering(callerSessionId)` inside
 * `handleHttpRequest` without needing a valid JSON-RPC body: that call happens
 * BEFORE the request body is read (see mcp-http-server.ts), so a bogus body is
 * sufficient to exercise the coordinator lazy-build path. Uses `node:http`
 * directly (not fetch) to match the pattern in mcp-server-network-config.test.ts.
 */
function postToPath(port: number, pathname: string, token: string): Promise<{ statusCode: number }> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: pathname,
        method: 'POST',
        headers: {
          Accept: 'application/json, text/event-stream',
          'Content-Type': 'application/json',
          'X-Kangentic-Token': token,
        },
      },
      (response) => {
        response.resume();
        response.on('end', () => resolve({ statusCode: response.statusCode ?? 0 }));
      },
    );
    request.on('error', reject);
    request.end(JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 1 }));
  });
}

/** The slice of a JSON-RPC reply the tool-offer tests read. */
interface JsonRpcReply {
  statusCode: number;
  body: {
    result?: {
      tools?: Array<{ name: string }>;
      content?: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    error?: unknown;
  } | null;
}

/**
 * POSTs one JSON-RPC request and returns the parsed reply. The server runs in
 * stateless JSON mode (`enableJsonResponse`), so the reply is a single JSON body
 * and no `initialize` handshake is needed first.
 */
function postJsonRpc(port: number, pathname: string, token: string, message: Record<string, unknown>): Promise<JsonRpcReply> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: pathname,
        method: 'POST',
        headers: {
          Accept: 'application/json, text/event-stream',
          'Content-Type': 'application/json',
          'X-Kangentic-Token': token,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          let body: JsonRpcReply['body'] = null;
          try {
            body = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as JsonRpcReply['body'];
          } catch {
            // A non-JSON reply (a bare 4xx or 5xx) leaves body null; the caller asserts on statusCode.
          }
          resolve({ statusCode: response.statusCode ?? 0, body });
        });
      },
    );
    request.on('error', reject);
    request.end(JSON.stringify({ jsonrpc: '2.0', id: 1, ...message }));
  });
}

describe('startMcpHttpServer - SessionSendCoordinator lifecycle', () => {
  let handle: McpHttpServerHandle | undefined;

  afterEach(() => {
    handle?.close();
    handle = undefined;
  });

  it('detaches the coordinator\'s SessionManager listeners when the server is closed', async () => {
    const sessionManager = createFakeSteeringSessionManager();
    const steeringContext: McpSteeringContext = {
      sessionManager,
      terminalSubmit: { submitContent: vi.fn(() => Promise.resolve()) },
    };
    const resolver = makeResolver();

    handle = await startMcpHttpServer(
      (projectId) => (projectId === 'proj-1' ? resolver : null),
      () => ({ enabled: false, allowInteraction: false, allowNavigation: false, allowEval: false, restrictNavigationToLocalhost: false }),
      { bindAddress: '127.0.0.1' },
      () => steeringContext,
    );
    const port = Number(new URL(handle.baseUrl).port);

    await postToPath(port, '/mcp/proj-1/caller-session-xyz', handle.token);

    // A coordinator was actually built and subscribed before we assert close()
    // detached it - otherwise the post-close assertion below would pass
    // vacuously (0 listeners because none were ever attached).
    expect(sessionManager.listenerCount('activity')).toBeGreaterThan(0);
    expect(sessionManager.listenerCount('exit')).toBeGreaterThan(0);

    handle.close();

    // Red: removing `sessionSendCoordinator?.dispose();` from
    // startMcpHttpServer's returned close() (mcp-http-server.ts) leaves these
    // at their pre-close count instead of 0.
    expect(sessionManager.listenerCount('activity')).toBe(0);
    expect(sessionManager.listenerCount('exit')).toBe(0);
  });

  it('builds the SessionSendCoordinator once per server launch and reuses it across requests', async () => {
    const sessionManager = createFakeSteeringSessionManager();
    const steeringContext: McpSteeringContext = {
      sessionManager,
      terminalSubmit: { submitContent: vi.fn(() => Promise.resolve()) },
    };
    const resolver = makeResolver();

    handle = await startMcpHttpServer(
      (projectId) => (projectId === 'proj-1' ? resolver : null),
      () => ({ enabled: false, allowInteraction: false, allowNavigation: false, allowEval: false, restrictNavigationToLocalhost: false }),
      { bindAddress: '127.0.0.1' },
      () => steeringContext,
    );
    const port = Number(new URL(handle.baseUrl).port);

    await postToPath(port, '/mcp/proj-1/caller-a', handle.token);
    expect(sessionManager.listenerCount('activity')).toBe(1);
    expect(sessionManager.listenerCount('exit')).toBe(1);

    await postToPath(port, '/mcp/proj-1/caller-b', handle.token);

    // Red: removing the `if (!sessionSendCoordinator)` guard in
    // resolveSteering (mcp-http-server.ts) builds a fresh coordinator - and
    // re-subscribes a fresh 'activity'/'exit' listener pair - on every
    // request, so this would read 2 instead of 1.
    expect(sessionManager.listenerCount('activity')).toBe(1);
    expect(sessionManager.listenerCount('exit')).toBe(1);
  });
});

/**
 * Task #857: `kangentic_mark_background_service` marks the shells of the session
 * that calls it, so it is offered only to a connection whose URL names a task
 * session (`/mcp/<projectId>/<callerSessionId>`), and it is wired to the
 * SessionManager the steering context carries. The tool's own behavior is in
 * background-shell-tools.test.ts and the engine's in activity-engine.test.ts;
 * these cover the wiring in between, which neither of those crosses:
 * `resolveBackgroundShells` and the caller routing in `handleHttpRequest`.
 */
describe('startMcpHttpServer - kangentic_mark_background_service offer (task #857)', () => {
  const MARK_SERVICE_TOOL = 'kangentic_mark_background_service';
  /** A task-tool every full server registers, so a list that came back empty or broken cannot pass a "not offered" check. */
  const FULL_SERVER_TOOL = 'kangentic_list_tasks';
  let handle: McpHttpServerHandle | undefined;

  afterEach(() => {
    handle?.close();
    handle = undefined;
  });

  async function startServer(
    steeringContext: McpSteeringContext | null,
  ): Promise<{ port: number; token: string }> {
    const resolver = makeResolver();
    handle = await startMcpHttpServer(
      (projectId) => (projectId === 'proj-1' ? resolver : null),
      () => ({ enabled: false, allowInteraction: false, allowNavigation: false, allowEval: false, restrictNavigationToLocalhost: false }),
      { bindAddress: '127.0.0.1' },
      () => steeringContext,
    );
    return { port: Number(new URL(handle.baseUrl).port), token: handle.token };
  }

  function makeSteeringContext(sessionManager: ReturnType<typeof createFakeSteeringSessionManager>): McpSteeringContext {
    return {
      sessionManager,
      terminalSubmit: { submitContent: vi.fn(() => Promise.resolve()) },
    };
  }

  /**
   * The tool names a `tools/list` on this path returns. Asserts the list itself
   * came back, so a 5xx or a JSON-RPC error cannot read as "the tool is not offered".
   */
  async function listToolNames(port: number, token: string, pathname: string): Promise<string[]> {
    const reply = await postJsonRpc(port, pathname, token, { method: 'tools/list' });
    expect(reply.statusCode).toBe(200);
    expect(reply.body?.error).toBeUndefined();
    const toolNames = (reply.body?.result?.tools ?? []).map((tool) => tool.name);
    expect(toolNames.length).toBeGreaterThan(0);
    return toolNames;
  }

  it('offers the tool on a task-session caller URL', async () => {
    const { port, token } = await startServer(makeSteeringContext(createFakeSteeringSessionManager()));

    const toolNames = await listToolNames(port, token, '/mcp/proj-1/task-session-42');

    expect(toolNames).toContain(FULL_SERVER_TOOL);
    // Red: passing `undefined` instead of `resolveBackgroundShells(callerSessionId)`
    // to buildConfiguredMcpServer in handleHttpRequest drops the tool from the list.
    expect(toolNames).toContain(MARK_SERVICE_TOOL);
  });

  it('routes a call to the SessionManager with the session id from the URL and the shell ids', async () => {
    const sessionManager = createFakeSteeringSessionManager();
    const { port, token } = await startServer(makeSteeringContext(sessionManager));

    const reply = await postJsonRpc(port, '/mcp/proj-1/task-session-42', token, {
      method: 'tools/call',
      params: { name: MARK_SERVICE_TOOL, arguments: { shellIds: ['bserver01'] } },
    });

    expect(reply.statusCode).toBe(200);
    expect(reply.body?.error).toBeUndefined();
    // The session is the URL's, never a tool argument, so a caller cannot mark another session's shells.
    expect(sessionManager.markBackgroundShellsAsServices).toHaveBeenCalledTimes(1);
    expect(sessionManager.markBackgroundShellsAsServices).toHaveBeenCalledWith('task-session-42', ['bserver01']);
    expect(reply.body?.result?.isError).toBeFalsy();
    const resultText = (reply.body?.result?.content ?? []).map((entry) => entry.text).join('\n');
    expect(resultText).toContain('bserver01: marked as a service');
  });

  it('does not offer the tool, nor route a call, on a connection that names no session', async () => {
    const sessionManager = createFakeSteeringSessionManager();
    const { port, token } = await startServer(makeSteeringContext(sessionManager));

    const toolNames = await listToolNames(port, token, '/mcp/proj-1');

    expect(toolNames).toContain(FULL_SERVER_TOOL);
    expect(toolNames).not.toContain(MARK_SERVICE_TOOL);

    await postJsonRpc(port, '/mcp/proj-1', token, {
      method: 'tools/call',
      params: { name: MARK_SERVICE_TOOL, arguments: { shellIds: ['bserver01'] } },
    });
    expect(sessionManager.markBackgroundShellsAsServices).not.toHaveBeenCalled();
  });

  it('does not offer the tool to a workflow agent caller', async () => {
    const { port, token } = await startServer(makeSteeringContext(createFakeSteeringSessionManager()));

    const toolNames = await listToolNames(port, token, '/mcp/proj-1/workflow-wf1');

    expect(toolNames).toContain(FULL_SERVER_TOOL);
    expect(toolNames).not.toContain(MARK_SERVICE_TOOL);
  });

  it('does not offer the tool to a Knowledge Graph answer caller', async () => {
    const { port, token } = await startServer(makeSteeringContext(createFakeSteeringSessionManager()));

    const toolNames = await listToolNames(port, token, '/mcp/proj-1/answer-chat1');

    expect(toolNames).toContain('kangentic_search');
    expect(toolNames).not.toContain(MARK_SERVICE_TOOL);
  });

  it('does not offer the tool before the steering context exists, even to a task-session caller', async () => {
    const { port, token } = await startServer(null);

    const toolNames = await listToolNames(port, token, '/mcp/proj-1/task-session-42');

    expect(toolNames).toContain(FULL_SERVER_TOOL);
    expect(toolNames).not.toContain(MARK_SERVICE_TOOL);
  });
});
