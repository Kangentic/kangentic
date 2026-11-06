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
import * as os from 'node:os';
import * as path from 'node:path';

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
import type { BrowserToolDependencies } from '../../src/main/agent/mcp-http/browser-tools';
import { setRemoteProjectLookup } from '../../src/main/remote/host-paths';
import { setHostAccessLookup } from '../../src/main/remote/host-transfer';

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
    // resolveBackgroundShells asks before any tool family is built (task #859);
    // this suite is about the browser family, so no session reports background commands.
    reportsBackgroundCommands: () => false,
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
    // resolveBrowser passes a narrow ADAPTER over SessionManager. These tools
    // only need to resolve the caller's own task id; the lane's cookie jar is
    // keyed by that task id, so no worktree-path lookup is wired.
    expect(dependencies.sessions?.getSessionTaskId('caller-session-xyz')).toBe('task-with-worktree');
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

describe('startMcpHttpServer - resolveBrowser captureDirectory wiring (saveToFile)', () => {
  let handle: McpHttpServerHandle | undefined;

  afterEach(() => {
    handle?.close();
    handle = undefined;
    registerBrowserToolsSpy.mockClear();
  });

  function resolverWithProjectPath(projectId: string, projectPath: string | null): RequestResolver {
    const fakeIpcContext = { projectRepo: { list: () => [] } } as unknown as IpcContext;
    const fakeCommandContext = {
      getProjectPath: () => {
        if (projectPath === null) throw new Error('no project path');
        return projectPath;
      },
    } as unknown as CommandContext;
    return new RequestResolver({
      ipcContext: fakeIpcContext,
      defaultContext: fakeCommandContext,
      defaultProjectId: projectId,
      defaultProjectName: 'Test Project',
    });
  }

  async function startAndPost(
    resolver: RequestResolver,
    pathname: string,
    sessionCwd: string | undefined,
  ): Promise<() => string> {
    const fakeSessionManager = {
      ...makeFakeSessionManager(),
      getSessionCommandCwd: (sessionId: string) => (sessionId === 'worktree-sess' ? sessionCwd : undefined),
    };
    handle = await startMcpHttpServer(
      () => resolver,
      () => ({ enabled: true, allowInteraction: false, allowNavigation: false, allowEval: false, restrictNavigationToLocalhost: false }),
      { bindAddress: '127.0.0.1' },
      () => ({ sessionManager: fakeSessionManager as never, terminalSubmit: { submitContent: vi.fn(() => Promise.resolve()) } }),
    );
    await postToPath(Number(new URL(handle.baseUrl).port), pathname, handle.token);
    expect(registerBrowserToolsSpy).toHaveBeenCalledOnce();
    const captureDirectory = registerBrowserToolsSpy.mock.calls[0]?.[2]?.captureDirectory;
    expect(typeof captureDirectory).toBe('function');
    return captureDirectory;
  }

  it('lands a worktree caller under <sessionCwd>/.kangentic/captures/<sessionId>', async () => {
    const projectRoot = path.join(os.tmpdir(), 'kangentic-scope-project');
    const worktree = path.join(projectRoot, '.kangentic', 'worktrees', 'fix-login-5ff16815');
    const captureDirectory = await startAndPost(
      resolverWithProjectPath('proj-1', projectRoot),
      '/mcp/proj-1/worktree-sess',
      worktree,
    );

    expect(captureDirectory()).toBe(path.join(worktree, '.kangentic', 'captures', 'worktree-sess'));
  });

  it('lands a caller with no session id under <projectPath>/.kangentic/captures/shared', async () => {
    const projectRoot = path.join(os.tmpdir(), 'kangentic-scope-project');
    const captureDirectory = await startAndPost(
      resolverWithProjectPath('proj-1', projectRoot),
      '/mcp/proj-1',
      undefined,
    );

    expect(captureDirectory()).toBe(path.join(projectRoot, '.kangentic', 'captures', 'shared'));
  });

  it('falls back to the temp folder when the project path cannot be read and there is no session', async () => {
    const captureDirectory = await startAndPost(resolverWithProjectPath('proj-1', null), '/mcp/proj-1', undefined);

    expect(captureDirectory()).toBe(path.join(os.tmpdir(), 'kangentic-captures', 'proj-1'));
  });
});

describe('startMcpHttpServer - resolveBrowser host wiring (deliverCapture, fetchDroppedFiles)', () => {
  let handle: McpHttpServerHandle | undefined;
  const shell = path.join(os.tmpdir(), 'kangentic-remote-shell');

  afterEach(() => {
    handle?.close();
    handle = undefined;
    registerBrowserToolsSpy.mockClear();
    setRemoteProjectLookup(null);
    setHostAccessLookup(null);
  });

  async function dependenciesFor(projectPath: string): Promise<BrowserToolDependencies> {
    const fakeIpcContext = { projectRepo: { list: () => [] } } as unknown as IpcContext;
    const resolver = new RequestResolver({
      ipcContext: fakeIpcContext,
      defaultContext: { getProjectPath: () => projectPath } as unknown as CommandContext,
      defaultProjectId: 'proj-1',
      defaultProjectName: 'Test Project',
    });
    handle = await startMcpHttpServer(
      () => resolver,
      () => ({ enabled: true, allowInteraction: false, allowNavigation: false, allowEval: false, restrictNavigationToLocalhost: false }),
      { bindAddress: '127.0.0.1' },
      () => ({ sessionManager: makeFakeSessionManager() as never, terminalSubmit: { submitContent: vi.fn(() => Promise.resolve()) } }),
    );
    await postToPath(Number(new URL(handle.baseUrl).port), '/mcp/proj-1', handle.token);
    return registerBrowserToolsSpy.mock.calls[0]?.[2];
  }

  const saved = { filePath: path.join(shell, 'captures', 'dom.html'), fileUri: 'file:///x', bytes: 1, pruned: [] };

  // Without the project path reaching them, a remote project's captures stay on this computer and its dropped
  // files are read from this disk, which is the bug the host copy exists to fix.
  it('hands both host-aware dependencies the request project\'s path, so a remote project reaches its host', async () => {
    setRemoteProjectLookup((projectPath) => (projectPath === shell ? { hostId: 'host-1', path: '/home/dev/proj' } : null));
    setHostAccessLookup(() => null);
    const dependencies = await dependenciesFor(shell);

    await expect(dependencies.deliverCapture?.(saved)).rejects.toThrow();
    const fetched = await dependencies.fetchDroppedFiles?.(['/home/dev/proj/a.png'], path.join(shell, 'drops'));
    expect(fetched?.failures.length).toBeGreaterThan(0);
  });

  it('leaves a project on this computer alone: captures stay local and nothing is fetched', async () => {
    setRemoteProjectLookup(() => null);
    setHostAccessLookup(() => { throw new Error('a host was asked'); });
    const dependencies = await dependenciesFor(path.join(os.tmpdir(), 'kangentic-local-project'));

    expect(await dependencies.deliverCapture?.(saved)).toMatchObject({ filePath: saved.filePath, location: 'local' });
    expect(await dependencies.fetchDroppedFiles?.(['/tmp/a.png'], path.join(shell, 'drops'))).toBeNull();
  });
});
