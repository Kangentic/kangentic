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
 * (`SessionSendSessionManager & SteeringSessionLookup`), with listener-count
 * tracking so we can observe how many times the coordinator subscribed/
 * unsubscribed without reaching into mcp-http-server's private state.
 */
function createFakeSteeringSessionManager() {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  return {
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
