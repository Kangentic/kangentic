/**
 * Guards the `resolveBrowser` closure inside `startMcpHttpServer`
 * (src/main/agent/mcp-http-server.ts): for a request against
 * `/mcp/<projectId>/<callerSessionId>`, the `BrowserToolDependencies` object
 * handed to `registerBrowserTools` must carry THAT request's `projectId` and
 * `callerSessionId`, not the other way around and not a leftover from a prior
 * request.
 *
 * `buildConfiguredMcpServer` making `browser` a REQUIRED parameter (unlike the
 * optional `steering`) is the comment-documented anti-leak mechanism: "a
 * browser tool family built without caller scope is the cross-project pane
 * leak this parameter exists to prevent." `resolveBrowser(projectId,
 * callerSessionId)` takes two plain strings, so an accidental argument swap
 * type-checks silently and is invisible to
 * tests/unit/mcp-browser-tools-project-scope.test.ts, which hand-constructs
 * `BrowserToolDependencies` directly and never asks where the values came
 * from. This test is the one that asks.
 *
 * Strategy mirrors mcp-http-server-steering-lifecycle.test.ts: heavy leaf
 * modules are stubbed so mcp-http-server imports under node, a real HTTP
 * server is launched via startMcpHttpServer, and a real POST is sent to a
 * project/caller-scoped path. `registerBrowserTools` itself is mocked (rather
 * than exercised) so the assertion is purely "what dependencies object did the
 * server build", independent of the tool family's internal behavior.
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
vi.mock('../../src/devtools/mcp/register', () => ({ registerDevtoolsMcpTools: vi.fn() }));

// The module under test for THIS file: mocked out entirely so we assert only
// on what dependencies object mcp-http-server.ts builds and hands it, not on
// the real tool family's registration behavior (that belongs to
// mcp-browser-tools-project-scope.test.ts, which builds this object by hand).
// vi.hoisted() is required because vi.mock() factories are hoisted above any
// top-level variable declaration by Vitest's transform.
const { registerBrowserToolsSpy } = vi.hoisted(() => ({ registerBrowserToolsSpy: vi.fn() }));
vi.mock('../../src/main/agent/mcp-http/browser-tools', () => ({
  registerBrowserTools: registerBrowserToolsSpy,
}));

import { startMcpHttpServer, type McpHttpServerHandle } from '../../src/main/agent/mcp-http-server';
import { RequestResolver } from '../../src/main/agent/mcp-http/project-resolver';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import type { CommandContext } from '../../src/main/agent/commands/types';

function makeResolver(projectId: string): RequestResolver {
  const fakeIpcContext = { projectRepo: { list: () => [] } } as unknown as IpcContext;
  const fakeCommandContext = {} as unknown as CommandContext;
  return new RequestResolver({
    ipcContext: fakeIpcContext,
    defaultContext: fakeCommandContext,
    defaultProjectId: projectId,
    defaultProjectName: 'Test Project',
  });
}

/**
 * `resolveSteering` runs before `resolveBrowser` in `handleHttpRequest` and
 * builds a real `SessionSendCoordinator`, which subscribes 'activity'/'exit'
 * listeners via `.on()`. A session manager stub without `on`/`off` throws
 * there and the request never reaches `buildConfiguredMcpServer` at all, so
 * this needs the same shape as the coordinator-lifecycle test's fake, even
 * though these tests only care about the browser-scope wiring downstream.
 */
function makeFakeSessionManager() {
  return {
    isWritable: () => false,
    getActivityCache: () => ({}),
    findLiveSessionByTaskId: (taskId: string) =>
      (taskId === 'task-with-worktree' ? { id: 'sess-1', cwd: 'C:/w/worktrees/7' } : undefined),
    getSessionTaskId: (sessionId: string) =>
      (sessionId === 'caller-session-xyz' ? 'task-with-worktree' : undefined),
    getSessionProjectId: () => undefined,
    on() { return this; },
    off() { return this; },
  };
}

/**
 * Sends a POST that reaches `buildConfiguredMcpServer` (and therefore
 * `resolveBrowser`) inside `handleHttpRequest`. Uses `node:http` directly, the
 * same pattern as mcp-http-server-steering-lifecycle.test.ts.
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

describe('startMcpHttpServer - resolveBrowser caller-scope wiring', () => {
  let handle: McpHttpServerHandle | undefined;

  afterEach(() => {
    handle?.close();
    handle = undefined;
    registerBrowserToolsSpy.mockClear();
  });

  it('builds BrowserToolDependencies from THIS request\'s projectId and callerSessionId', async () => {
    const resolver = makeResolver('proj-1');
    const fakeSessionManager = makeFakeSessionManager();

    handle = await startMcpHttpServer(
      (projectId) => (projectId === 'proj-1' ? resolver : null),
      // enabled: true is required - registerBrowserTools is only called inside
      // `if (browserAutomationEnabled)`, so with enabled: false the spy never
      // fires and every assertion below would pass vacuously.
      () => ({ enabled: true, allowInteraction: false, allowNavigation: false, allowEval: false, restrictNavigationToLocalhost: false }),
      { bindAddress: '127.0.0.1' },
      () => ({ sessionManager: fakeSessionManager as never, terminalSubmit: { submitContent: vi.fn(() => Promise.resolve()) } }),
    );
    const port = Number(new URL(handle.baseUrl).port);

    await postToPath(port, '/mcp/proj-1/caller-session-xyz', handle.token);

    expect(registerBrowserToolsSpy).toHaveBeenCalledOnce();
    const dependencies = registerBrowserToolsSpy.mock.calls[0]?.[2];
    expect(dependencies).toMatchObject({
      projectId: 'proj-1',
      callerSessionId: 'caller-session-xyz',
    });
    // Deliberately NOT `toBe(fakeSessionManager)`. resolveBrowser passes an
    // ADAPTER now, because SessionManager satisfies the rest of
    // BrowserSessionLookup structurally while having no getTaskWorktreePath -
    // which is exactly how that lookup once shipped dead, sending every
    // isolated lane to the legacy shared cookie jar. Behaviour is the stronger
    // assertion anyway: identity never proved the lookup resolved anything.
    expect(dependencies.sessions?.getSessionTaskId('caller-session-xyz')).toBe('task-with-worktree');
    expect(dependencies.sessions?.getTaskWorktreePath('task-with-worktree')).toBe('C:/w/worktrees/7');
    // A task with no live session yields null rather than throwing; openLane
    // then falls back to the shared jar, which is the honest answer when there
    // is no worktree to key on.
    expect(dependencies.sessions?.getTaskWorktreePath('task-without-session')).toBeNull();
  });

  it('scopes each request to ITS OWN projectId - a second project never inherits the first\'s scope', async () => {
    // Two projects registered on the same running server; each connects on
    // its own URL segment. This is the direct regression check for a swapped
    // or hoisted resolveBrowser argument: if projectId were read from a
    // captured/stale value, project-2's request would resolve with
    // project-1's id (or vice versa).
    const resolverOne = makeResolver('proj-1');
    const resolverTwo = makeResolver('proj-2');

    handle = await startMcpHttpServer(
      (projectId) => {
        if (projectId === 'proj-1') return resolverOne;
        if (projectId === 'proj-2') return resolverTwo;
        return null;
      },
      () => ({ enabled: true, allowInteraction: false, allowNavigation: false, allowEval: false, restrictNavigationToLocalhost: false }),
      { bindAddress: '127.0.0.1' },
    );
    const port = Number(new URL(handle.baseUrl).port);

    await postToPath(port, '/mcp/proj-1/caller-a', handle.token);
    await postToPath(port, '/mcp/proj-2/caller-b', handle.token);

    expect(registerBrowserToolsSpy).toHaveBeenCalledTimes(2);
    expect(registerBrowserToolsSpy.mock.calls[0]?.[2]).toMatchObject({
      projectId: 'proj-1',
      callerSessionId: 'caller-a',
    });
    expect(registerBrowserToolsSpy.mock.calls[1]?.[2]).toMatchObject({
      projectId: 'proj-2',
      callerSessionId: 'caller-b',
    });
  });
});
