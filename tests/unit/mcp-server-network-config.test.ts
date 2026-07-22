/**
 * Guards the MCP HTTP server's network configuration (bind address + callback
 * host) added for LAN/VPN-reachable remote agent servers.
 *
 *   1. `buildAllowedHosts` (extracted pure function): the default loopback
 *      allowlist, and the widened allowlist once bindAddress/callbackHost are
 *      configured - missing this would silently 403 every legitimate LAN
 *      request via the SDK's DNS-rebinding protection.
 *   2. `startMcpHttpServer`'s `urlForProject`/`baseUrl`: stay on loopback
 *      regardless of bindAddress/callbackHost - every local consumer
 *      (`.kangentic/mcp-config.json`, per-session `mcp.json`) is unaffected
 *      by widening either network setting.
 *   3. `DEFAULT_CONFIG.mcpServer`: bindAddress defaults to loopback, callbackHost
 *      stays unset - the acceptance bar that existing users see zero change.
 *
 * Heavy leaf modules are stubbed so mcp-http-server imports under node (mirrors
 * mcp-server-config-gating.test.ts).
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

import { buildAllowedHosts, startMcpHttpServer, type McpHttpServerHandle } from '../../src/main/agent/mcp-http-server';
import { DEFAULT_CONFIG } from '../../src/shared/types';
import { RequestResolver } from '../../src/main/agent/mcp-http/project-resolver';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import type { CommandContext } from '../../src/main/agent/commands/types';

/**
 * Sends a raw HTTP request with a caller-controlled `Host` header. Node's
 * `fetch` (undici) silently overwrites a `Host` header set via its `headers`
 * option with the actual connection host, so DNS-rebinding-protection tests
 * MUST go through `node:http` directly to prove what the SDK's transport
 * really sees.
 */
function postWithHost(
  port: number,
  pathname: string,
  hostHeader: string,
  token: string,
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const requestBody = JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 1 });
    const request = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: pathname,
        method: 'POST',
        headers: {
          Host: hostHeader,
          Accept: 'application/json, text/event-stream',
          'Content-Type': 'application/json',
          'X-Kangentic-Token': token,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          resolve({ statusCode: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') });
        });
      },
    );
    request.on('error', reject);
    request.end(requestBody);
  });
}

describe('buildAllowedHosts', () => {
  it('allows only loopback by default', () => {
    const hosts = buildAllowedHosts(5173, { bindAddress: '127.0.0.1' });
    expect(hosts).toEqual(['127.0.0.1', '127.0.0.1:5173', 'localhost', '[::1]']);
  });

  it('adds the widened bindAddress and configured callbackHost', () => {
    const hosts = buildAllowedHosts(5173, { bindAddress: '10.0.0.5', callbackHost: '10.0.0.5' });
    expect(hosts).toContain('10.0.0.5');
    expect(hosts).toContain('10.0.0.5:5173');
    // Still keeps loopback - local consumers are unaffected by widening.
    expect(hosts).toContain('127.0.0.1');
  });

  it('does not duplicate loopback when bindAddress/callbackHost are left at 127.0.0.1', () => {
    const hosts = buildAllowedHosts(5173, { bindAddress: '127.0.0.1', callbackHost: '127.0.0.1' });
    expect(hosts.filter((host) => host === '127.0.0.1').length).toBe(1);
  });

  it('brackets an IPv6 callbackHost literal the way a client actually sends it', () => {
    const hosts = buildAllowedHosts(5173, { bindAddress: '127.0.0.1', callbackHost: '2001:db8::1' });
    expect(hosts).toContain('[2001:db8::1]');
    expect(hosts).toContain('[2001:db8::1]:5173');
    // The SDK does an exact string compare, so the unbracketed form must
    // never be the thing that's allowlisted - it will never match a real
    // `Host: [2001:db8::1]:51234` header.
    expect(hosts).not.toContain('2001:db8::1');
    expect(hosts).not.toContain('2001:db8::1:5173');
  });

  it('does not double-bracket an already-bracketed IPv6 callbackHost', () => {
    const hosts = buildAllowedHosts(5173, { bindAddress: '127.0.0.1', callbackHost: '[2001:db8::1]' });
    expect(hosts).toContain('[2001:db8::1]');
    expect(hosts).toContain('[2001:db8::1]:5173');
    expect(hosts.some((host) => host.includes('[[2001:db8::1]]'))).toBe(false);
  });

  it('leaves an IPv4 bindAddress unbracketed (regression guard on the colon discriminator)', () => {
    const hosts = buildAllowedHosts(5173, { bindAddress: '10.0.0.5' });
    expect(hosts).toContain('10.0.0.5');
    expect(hosts).toContain('10.0.0.5:5173');
    expect(hosts.some((host) => host.includes('[10.0.0.5]'))).toBe(false);
  });
});

describe('startMcpHttpServer - network config', () => {
  let handle: McpHttpServerHandle | undefined;

  afterEach(() => {
    handle?.close();
    handle = undefined;
  });

  it('urlForProject stays on loopback regardless of bindAddress/callbackHost (default parity)', async () => {
    handle = await startMcpHttpServer(
      () => null,
      () => ({ enabled: false, allowInteraction: false, allowNavigation: false, allowEval: false, restrictNavigationToLocalhost: false }),
      { bindAddress: '127.0.0.1', callbackHost: '10.0.0.5' },
    );
    const port = new URL(handle.baseUrl).port;
    expect(handle.urlForProject('proj-1')).toBe(`http://127.0.0.1:${port}/mcp/proj-1`);
    expect(handle.baseUrl).toBe(`http://127.0.0.1:${port}/mcp`);
  });
});

describe('startMcpHttpServer - allowedHosts wiring (Hole 1)', () => {
  let handle: McpHttpServerHandle | undefined;

  afterEach(() => {
    handle?.close();
    handle = undefined;
  });

  /**
   * Proves buildAllowedHosts's result actually reaches the SDK transport's
   * DNS-rebinding check, not just that the pure function returns the right
   * array. Bind stays on loopback (portable across CI/local); only the
   * allowlist entry is widened via `callbackHost`.
   *
   * The project resolver must be non-null: handleHttpRequest 404s BEFORE
   * constructing the transport when `buildContext` returns null
   * (src/main/agent/mcp-http-server.ts, the `if (!resolver)` branch ahead of
   * `buildConfiguredMcpServer`/`new StreamableHTTPServerTransport`), so a
   * null-returning resolver would never reach the host-header check at all.
   */
  it('accepts the configured callbackHost and rejects a bogus Host header', async () => {
    const callbackHost = 'mcp.example.test';
    const fakeIpcContext = { projectRepo: { list: () => [] } } as unknown as IpcContext;
    const fakeCommandContext = {} as unknown as CommandContext;
    const resolver = new RequestResolver({
      ipcContext: fakeIpcContext,
      defaultContext: fakeCommandContext,
      defaultProjectId: 'proj-1',
      defaultProjectName: 'Test Project',
    });

    handle = await startMcpHttpServer(
      (projectId) => (projectId === 'proj-1' ? resolver : null),
      () => ({ enabled: false, allowInteraction: false, allowNavigation: false, allowEval: false, restrictNavigationToLocalhost: false }),
      { bindAddress: '127.0.0.1', callbackHost },
    );
    const port = Number(new URL(handle.baseUrl).port);

    const allowedResponse = await postWithHost(port, '/mcp/proj-1', callbackHost, handle.token);
    expect(allowedResponse.statusCode).not.toBe(403);
    expect(allowedResponse.body).not.toContain('Invalid Host header');

    const rejectedResponse = await postWithHost(port, '/mcp/proj-1', 'evil.example.test', handle.token);
    expect(rejectedResponse.statusCode).toBe(403);
    expect(rejectedResponse.body).toContain('Invalid Host header');
  });
});

describe('DEFAULT_CONFIG.mcpServer - network defaults reproduce today\'s behavior', () => {
  it('binds to loopback and leaves callbackHost unset', () => {
    expect(DEFAULT_CONFIG.mcpServer.bindAddress).toBe('127.0.0.1');
    expect(DEFAULT_CONFIG.mcpServer.callbackHost).toBeUndefined();
    expect(DEFAULT_CONFIG.mcpServer.enabled).toBe(true);
  });
});
