import { describe, it, expect, vi, afterEach } from 'vitest';

/**
 * Verifies the startMcpHttpServer -> makeTaskCounter forwarding seam:
 * the taskCreateLimit passed to startMcpHttpServer must be threaded
 * through to makeTaskCounter unchanged. Without this test, reverting
 * `makeTaskCounter(taskCreateLimit)` to `makeTaskCounter()` in the
 * body of startMcpHttpServer would pass every existing test green.
 *
 * Strategy: spy on makeTaskCounter via vi.mock+vi.hoisted so we can
 * assert the exact argument it received. The test binds a real port-0
 * HTTP server (Node std-lib only, no Electron, no native modules) and
 * closes it immediately - no requests are sent, so the request-time
 * handler (handleHttpRequest -> buildConfiguredMcpServer -> McpServer)
 * never fires.
 *
 * Red-green: change `makeTaskCounter(taskCreateLimit)` in
 * src/main/agent/mcp-http-server.ts to `makeTaskCounter()` (drop the
 * arg) - "forwards a concrete limit" fails with "Expected 7, received
 * undefined". Restore - green.
 */

// vi.hoisted lifts the spy constructor above the vi.mock factories so
// the factory closures can close over the spy instance without a TDZ error.
const { mockMakeTaskCounter } = vi.hoisted(() => {
  const mockMakeTaskCounter = vi.fn((maxPerLaunch?: number) => {
    // Minimal counter stub: the real implementation is unit-tested in
    // mcp-task-counter.test.ts. Returns a valid TaskCounter interface so
    // the server can close over the result without throwing.
    const ceiling = maxPerLaunch ?? 50;
    let count = 0;
    return {
      tryReserve: () => { if (count >= ceiling) return false; count++; return true; },
      limit: () => ceiling,
    };
  });
  return { mockMakeTaskCounter };
});

// ── Mock every direct dependency of mcp-http-server.ts that would otherwise
//    pull in native modules (better-sqlite3, electron). These are mocked at the
//    direct-import level to avoid chasing transitive deps.
//
// handler-helpers: spy on makeTaskCounter; all other exports are noops because
// they are only called per-request (handleHttpRequest is never invoked here).
vi.mock('../../src/main/agent/mcp-http/handler-helpers', () => ({
  makeTaskCounter: mockMakeTaskCounter,
}));

// The *-tools.ts modules import handler-helpers (and some add search-core ->
// better-sqlite3 or process-metrics/cdp -> electron). Mocking them prevents
// the full chain from loading; the mocked registration functions are noops
// since they are only called inside buildConfiguredMcpServer, which itself is
// only invoked per-request.
vi.mock('../../src/main/agent/mcp-http/task-tools', () => ({
  registerTaskTools: vi.fn(),
}));
vi.mock('../../src/main/agent/mcp-http/session-tools', () => ({
  registerSessionTools: vi.fn(),
}));
vi.mock('../../src/main/agent/mcp-http/project-tools', () => ({
  registerProjectTools: vi.fn(),
}));
vi.mock('../../src/main/agent/mcp-http/search-tools', () => ({
  registerSearchTools: vi.fn(),
}));
vi.mock('../../src/main/agent/mcp-http/diagnostics-tools', () => ({
  registerDiagnosticsTools: vi.fn(),
}));
// browser-tools imports browser-pane-driver, browser-pane-registry, and
// cdp/cdp.ts, all of which import from 'electron'.
vi.mock('../../src/main/agent/mcp-http/browser-tools', () => ({
  registerBrowserTools: vi.fn(),
}));
// server-instructions imports browser-pane-registry -> electron.
vi.mock('../../src/main/agent/mcp-http/server-instructions', () => ({
  buildServerInstructions: vi.fn(() => 'mock server instructions'),
}));
// tool-call-logging has no problematic deps but is mocked for symmetry
// so any future imports added to it cannot silently break this test.
vi.mock('../../src/main/agent/mcp-http/tool-call-logging', () => ({
  logMcpToolArguments: vi.fn(),
}));
// devtools/mcp/register is imported at the top of mcp-http-server.ts even
// though __KANGENTIC_DEV__ = false (dead-code elimination only happens in
// the esbuild production build, not in Vitest's transformer).
vi.mock('../../src/devtools/mcp/register', () => ({
  registerDevtoolsMcpTools: vi.fn(),
}));

import { startMcpHttpServer } from '../../src/main/agent/mcp-http-server';
import type { ProjectContextFactory } from '../../src/main/agent/mcp-http-server';
import type { AutomationConfigReader } from '../../src/main/agent/mcp-http/browser-tools';

describe('startMcpHttpServer -> makeTaskCounter forwarding seam', () => {
  // Minimal stubs for the two required factory args. buildContext returning null
  // means "no project found" (a 404 per the HTTP handler), but since no requests
  // are sent, the value is never consulted.
  const mockBuildContext: ProjectContextFactory = () => null;
  const mockGetBrowserConfig: AutomationConfigReader = () => ({
    enabled: false,
    allowInteraction: false,
    allowNavigation: false,
    allowEval: false,
    restrictToLocalhost: true,
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('forwards a concrete taskCreateLimit to makeTaskCounter', async () => {
    // Red-green: change `makeTaskCounter(taskCreateLimit)` to
    // `makeTaskCounter()` in startMcpHttpServer - this test fails with
    // "Expected: 7, received: undefined". Restore - green.
    const LIMIT = 7;
    const handle = await startMcpHttpServer(mockBuildContext, mockGetBrowserConfig, LIMIT);
    try {
      expect(mockMakeTaskCounter).toHaveBeenCalledOnce();
      expect(mockMakeTaskCounter).toHaveBeenCalledWith(LIMIT);
    } finally {
      handle.close();
    }
  });

  it('forwards undefined when no taskCreateLimit is supplied', async () => {
    // When the caller omits the third argument, startMcpHttpServer passes
    // undefined to makeTaskCounter, letting makeTaskCounter apply its own
    // default. This guards against startMcpHttpServer hardcoding a fallback
    // value (e.g. `makeTaskCounter(50)`) instead of forwarding transparently.
    const handle = await startMcpHttpServer(mockBuildContext, mockGetBrowserConfig);
    try {
      expect(mockMakeTaskCounter).toHaveBeenCalledOnce();
      // The first argument must be undefined (not a hardcoded value like 50).
      const [receivedArg] = mockMakeTaskCounter.mock.calls[0];
      expect(receivedArg).toBeUndefined();
    } finally {
      handle.close();
    }
  });
});
