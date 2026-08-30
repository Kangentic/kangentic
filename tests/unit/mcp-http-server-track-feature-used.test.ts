/**
 * Guards the `mcp_server` adoption signal in `handleHttpRequest`
 * (src/main/agent/mcp-http-server.ts): a POST body whose parsed JSON-RPC
 * message(s) include `method: 'initialize'` fires
 * `trackFeatureUsed('mcp_server')` exactly once per matching request. This is
 * the "an MCP client actually connected" signal - deliberately not fired for
 * every tool call, and deliberately gated on the JSON-RPC method name rather
 * than any other request shape (the body is parsed once and handed straight
 * to the SDK transport, so a broken `.some(...)` scan would silently stop
 * classifying requests without touching dispatch at all).
 *
 * Drives real request bodies through a real `startMcpHttpServer` instance via
 * `node:http`, mirroring the harness in mcp-http-server-steering-lifecycle
 * .test.ts and mcp-server-network-config.test.ts (both already prove this
 * dispatch path is drivable without restructuring source). `analytics/usage`
 * is left real (unmocked) so the actual `.some(...)` classification in
 * mcp-http-server.ts is exercised end to end; only the underlying
 * `analytics/analytics` trackEvent sink is mocked (its own module pulls in
 * `@aptabase/electron/main`, which cannot load outside a real Electron
 * process - see the identical note in register-all-idempotency.test.ts).
 *
 * Heavy leaf modules are stubbed so mcp-http-server imports under node
 * (mirrors the sibling mcp-http-server-*.test.ts files).
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
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

// analytics.ts module-level-imports '@aptabase/electron/main', a real
// node_modules package that cannot load outside a real Electron process (see
// the identical note in register-all-idempotency.test.ts). trackFeatureUsed
// (analytics/usage.ts) is left REAL so the source's own `.some(...)`
// initialize-detection is what's under test, not a stand-in for it.
const mockTrackEvent = vi.fn();
vi.mock('../../src/main/analytics/analytics', () => ({
  trackEvent: (...args: unknown[]) => mockTrackEvent(...args),
}));

import { startMcpHttpServer, type McpHttpServerHandle } from '../../src/main/agent/mcp-http-server';
import { RequestResolver } from '../../src/main/agent/mcp-http/project-resolver';
import { resetUsageAnalyticsForTests } from '../../src/main/analytics/usage';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import type { CommandContext } from '../../src/main/agent/commands/types';

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

/** POSTs an arbitrary (possibly malformed) JSON body to the running server. */
function postBody(
  port: number,
  token: string,
  rawBody: string,
): Promise<{ statusCode: number }> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/mcp/proj-1',
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
    request.end(rawBody);
  });
}

function featureUsedCalls(): unknown[][] {
  return mockTrackEvent.mock.calls.filter((call) => call[0] === 'feature_used');
}

describe('mcp-http-server - mcp_server adoption tracking on initialize', () => {
  let handle: McpHttpServerHandle | undefined;

  beforeEach(() => {
    mockTrackEvent.mockClear();
    // trackFeatureUsed dedups 'feature_used' to once per feature per UTC day
    // via a module-level Map in usage.ts, which persists across tests in this
    // file (vitest shares module instances within one file). Without this
    // reset, only the FIRST test in this describe block would ever observe a
    // 'feature_used' call - every later test's real trackFeatureUsed call
    // would silently no-op against the same-day dedup, which looks identical
    // to "initialize detection is broken" from the outside.
    resetUsageAnalyticsForTests();
  });

  afterEach(() => {
    handle?.close();
    handle = undefined;
  });

  it('fires trackFeatureUsed(\'mcp_server\') for a single {method: "initialize"} body', async () => {
    const resolver = makeResolver();
    handle = await startMcpHttpServer(
      (projectId) => (projectId === 'proj-1' ? resolver : null),
      () => ({ enabled: false, allowInteraction: false, allowNavigation: false, allowEval: false, restrictNavigationToLocalhost: false }),
      { bindAddress: '127.0.0.1' },
    );
    const port = Number(new URL(handle.baseUrl).port);

    await postBody(port, handle.token, JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1 }));

    // Red: removing the `rpcMessages.some(...)` check (or the trackFeatureUsed
    // call it guards) in handleHttpRequest leaves this at 0 matching calls.
    expect(featureUsedCalls()).toEqual([['feature_used', { feature: 'mcp_server' }]]);
  });

  it('fires trackFeatureUsed(\'mcp_server\') for an ARRAY body containing an initialize message', async () => {
    const resolver = makeResolver();
    handle = await startMcpHttpServer(
      (projectId) => (projectId === 'proj-1' ? resolver : null),
      () => ({ enabled: false, allowInteraction: false, allowNavigation: false, allowEval: false, restrictNavigationToLocalhost: false }),
      { bindAddress: '127.0.0.1' },
    );
    const port = Number(new URL(handle.baseUrl).port);

    // Batched JSON-RPC: an array of messages, one of which is initialize.
    await postBody(port, handle.token, JSON.stringify([
      { jsonrpc: '2.0', method: 'notifications/other', params: {} },
      { jsonrpc: '2.0', method: 'initialize', id: 1 },
    ]));

    // Red: reverting the `Array.isArray(parsedBody) ? parsedBody : [parsedBody]`
    // normalization to a bare `[parsedBody]` would scan the whole array as one
    // opaque message (no `.method` on an array), and this would read 0 calls.
    expect(featureUsedCalls()).toEqual([['feature_used', { feature: 'mcp_server' }]]);
  });

  it('does NOT fire trackFeatureUsed for a {method: "tools/call"} body', async () => {
    const resolver = makeResolver();
    handle = await startMcpHttpServer(
      (projectId) => (projectId === 'proj-1' ? resolver : null),
      () => ({ enabled: false, allowInteraction: false, allowNavigation: false, allowEval: false, restrictNavigationToLocalhost: false }),
      { bindAddress: '127.0.0.1' },
    );
    const port = Number(new URL(handle.baseUrl).port);

    await postBody(port, handle.token, JSON.stringify({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'kangentic_list_tasks', arguments: {} },
      id: 1,
    }));

    expect(featureUsedCalls()).toEqual([]);
  });

  it('does not throw and does not fire trackFeatureUsed for a null-parsed body', async () => {
    const resolver = makeResolver();
    handle = await startMcpHttpServer(
      (projectId) => (projectId === 'proj-1' ? resolver : null),
      () => ({ enabled: false, allowInteraction: false, allowNavigation: false, allowEval: false, restrictNavigationToLocalhost: false }),
      { bindAddress: '127.0.0.1' },
    );
    const port = Number(new URL(handle.baseUrl).port);

    // `JSON.parse('null')` succeeds and yields the value `null`, so this
    // reaches the initialize-detection block with parsedBody === null - unlike
    // a malformed/unparseable body, which the earlier catch already handles
    // and never reaches this code at all.
    const response = await postBody(port, handle.token, 'null');

    expect(response.statusCode).not.toBe(0);
    expect(featureUsedCalls()).toEqual([]);
  });
});
