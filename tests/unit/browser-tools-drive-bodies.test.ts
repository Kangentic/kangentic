/**
 * Exercises the actual CALLBACK BODIES `registerBrowserTools` hands to
 * `withGuest`, for the two tools whose bodies changed in the browser-
 * contention branch: `kangentic_browser_wait` and `kangentic_browser_screenshot`.
 *
 * Every other browser-tools test in this repo mocks `withGuest` to return a
 * stubbed refusal envelope WITHOUT ever invoking the callback
 * (`mcp-browser-tools-project-scope.test.ts` does this deliberately, to keep
 * its assertions on the selector rather than the body), so none of them
 * exercise the logic below. This file's `withGuest` stub actually calls the
 * body against a fake `webContents`, the same pattern
 * `browser-pane-opener.test.ts` uses for the opener.
 *
 * Two behaviors pinned here:
 *
 * 1. `kangentic_browser_wait` now polls with ONE lock acquisition per poll
 *    (rather than one 60s-long drive), and a REFUSAL from any single poll ends
 *    the wait immediately instead of being retried until the deadline. Without
 *    that early break, the next line reads `result.data.matched` off a `{ok:
 *    false}` envelope, which has no `.data` - so a regression here does not
 *    degrade into a slower wait, it throws.
 * 2. `kangentic_browser_screenshot` probes for a dev-server build-error overlay
 *    in the SAME drive as the capture, and short-circuits before ever calling
 *    `captureScreenshotWithBudget` when one is present - so an agent is never
 *    handed a picture of a red error overlay to spend a turn interpreting.
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
vi.mock('../../src/devtools/mcp/register', () => ({ registerDevtoolsMcpTools: vi.fn() }));
vi.mock('../../src/main/browser/browser-pane-registry', () => ({
  browserPaneRegistry: {
    list: vi.fn(() => []),
    listForProject: vi.fn(() => ({ panes: [], otherProjectPaneCount: 0, unknownProjectPaneCount: 0 })),
  },
}));

// getOuterHtml drives the `wait` poll body; captureScreenshotWithBudget drives
// the screenshot body's non-blocked path.
const getOuterHtml = vi.fn();
vi.mock('../../src/main/browser/cdp/cdp', () => ({
  clickAtCenterOfSelector: vi.fn(),
  dispatchMouseEvent: vi.fn(),
  dispatchKeyEvent: vi.fn(),
  dispatchKeypress: vi.fn(),
  dragFromTo: vi.fn(),
  getOuterHtml: (...args: unknown[]) => getOuterHtml(...args),
  getBoundingBox: vi.fn(),
  getConsoleEntries: vi.fn(),
  getLayoutMetrics: vi.fn(),
  queryAllElements: vi.fn(),
  runtimeEvaluate: vi.fn(),
  typeText: vi.fn(),
}));

const captureScreenshotWithBudget = vi.fn();
vi.mock('../../src/main/browser/cdp/screenshot', () => ({
  captureScreenshotWithBudget: (...args: unknown[]) => captureScreenshotWithBudget(...args),
  captureElementClip: vi.fn(),
}));

// detectDevServerError is stubbed per test; describeDevServerError stays REAL
// so the composed error detail is the actual product wording, not a value this
// test invented and could get out of sync with.
const detectDevServerError = vi.fn();
vi.mock('../../src/main/browser/dev-server-error', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/browser/dev-server-error')>();
  return { ...actual, detectDevServerError: (...args: unknown[]) => detectDevServerError(...args) };
});

// withGuest ACTUALLY RUNS the callback against a fake webContents, unlike the
// stubbed-refusal mock every other browser-tools test uses. A test overrides
// it per-case (mockResolvedValueOnce) to simulate a mid-poll refusal.
const fakeGuest = {} as never;
vi.mock('../../src/main/browser/browser-pane-driver', () => ({
  withGuest: vi.fn(async (_options: unknown, fn: (webContents: unknown) => Promise<unknown>) => ({
    ok: true,
    data: await fn(fakeGuest),
  })),
  validateNavigationUrl: vi.fn((url: string) => ({ ok: true, url })),
  navigateGuest: vi.fn(),
}));

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildConfiguredMcpServer } from '../../src/main/agent/mcp-http-server';
import { withGuest } from '../../src/main/browser/browser-pane-driver';
import type { TaskCounter } from '../../src/main/agent/mcp-http/handler-helpers';
import type { RequestResolver } from '../../src/main/agent/mcp-http/project-resolver';
import type { ResolvedBrowserAutomationConfig } from '../../src/main/browser/browser-automation-config';
import type { BrowserToolDependencies } from '../../src/main/agent/mcp-http/browser-tools';

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
  return { enabled: true, allowInteraction: true, allowNavigation: true, allowEval: true, restrictNavigationToLocalhost: false };
}

async function connect() {
  const browser: BrowserToolDependencies = { projectId: CALLER_PROJECT };
  const server = buildConfiguredMcpServer(makeResolver(), fakeTaskCounter, automationConfig, null, browser);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'drive-body-guard', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(withGuest).mockImplementation(async (_options, fn) => ({ ok: true, data: await fn(fakeGuest) }));
});

describe('kangentic_browser_wait: per-poll lock, break-on-refusal', () => {
  it('ends the wait on the FIRST refusal rather than retrying to the deadline', async () => {
    // A refusal (pane destroyed, busy, policy) from a single poll must not be
    // treated as "not yet matched" - that would burn the whole timeout window
    // reporting a refusal the very first poll already knew about.
    vi.mocked(withGuest).mockResolvedValueOnce({
      ok: false,
      error: { kind: 'pane-busy', detail: 'Guest is busy with another drive.' },
    });
    const { client, close } = await connect();

    const result = await client.callTool({
      name: 'kangentic_browser_wait',
      arguments: { selector: 'body', timeoutMs: 30000, intervalMs: 250 },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: { kind: 'pane-busy' } });
    // The whole point: exactly one poll ran, not a retry loop.
    expect(vi.mocked(withGuest)).toHaveBeenCalledTimes(1);
    await close();
  });

  it('keeps polling across an unmatched poll and resolves once a later poll matches', async () => {
    // Proves the break above is refusal-specific, not "stop after any poll":
    // an ok:true, not-yet-matched poll must NOT end the wait.
    getOuterHtml.mockResolvedValueOnce(null); // first poll: element not found yet
    getOuterHtml.mockResolvedValueOnce('<div id="target">hello world</div>'); // second poll: matches
    const { client, close } = await connect();

    const result = await client.callTool({
      name: 'kangentic_browser_wait',
      arguments: { selector: '#target', domText: 'hello', timeoutMs: 5000, intervalMs: 1 },
    });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ matched: true });
    expect(vi.mocked(withGuest)).toHaveBeenCalledTimes(2);
    await close();
  });
});

describe('kangentic_browser_screenshot: dev-server-error short-circuit', () => {
  it('never calls captureScreenshotWithBudget when a build-error overlay is detected', async () => {
    detectDevServerError.mockResolvedValue({
      kind: 'vite',
      message: 'Unexpected token }',
      file: 'src/App.tsx:12:3',
    });
    const { client, close } = await connect();

    const result = await client.callTool({ name: 'kangentic_browser_screenshot', arguments: {} });

    expect(captureScreenshotWithBudget).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: { kind: 'dev-server-error' } });
    const detail = (result.structuredContent as { error: { detail: string } }).error.detail;
    // The real describeDevServerError wording (not re-invented here), so this
    // stays coupled to dev-server-error.test.ts's pinned contract.
    expect(detail).toContain('src/App.tsx:12:3');
    expect(detail).toContain('Unexpected token }');
    await close();
  });

  it('captures normally when no overlay is present', async () => {
    detectDevServerError.mockResolvedValue(null);
    captureScreenshotWithBudget.mockResolvedValue({
      mode: 'inline',
      format: 'jpeg',
      base64: 'ZmFrZQ==',
      byteLength: 4,
      width: 100,
      height: 100,
      viewportWidth: 100,
      viewportHeight: 100,
      deviceScaleFactor: 1,
      scale: 1,
      fullPage: false,
      elementClip: null,
      retries: 0,
    });
    const { client, close } = await connect();

    const result = await client.callTool({ name: 'kangentic_browser_screenshot', arguments: {} });

    expect(captureScreenshotWithBudget).toHaveBeenCalledTimes(1);
    expect(result.isError).toBeUndefined();
    expect(result.content).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'image', mimeType: 'image/jpeg' })]),
    );
    await close();
  });
});
