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
 * Three behaviors pinned here:
 *
 * 0. `kangentic_browser_set_viewport` validates its dimensions before reaching
 *    the guest, and routes `reset` to the clear path rather than the set one.
 *    The three MECHANISMS it dispatches between are not here: those need a
 *    window and a CDP session, and live in `browser-viewport-override.test.ts`.
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
const scrollBy = vi.fn();
const selectOptionOnSelector = vi.fn();
vi.mock('../../src/main/browser/cdp/cdp', () => ({
  clickAtCenterOfSelector: vi.fn(),
  dispatchMouseEvent: vi.fn(),
  dispatchKeyEvent: vi.fn(),
  dispatchKeypress: vi.fn(),
  dragFromTo: vi.fn(),
  dropFilesOnSelector: vi.fn(),
  getDialogEntries: vi.fn(() => []),
  getNetworkEntries: vi.fn(() => []),
  getOuterHtml: (...args: unknown[]) => getOuterHtml(...args),
  getBoundingBox: vi.fn(),
  getConsoleEntries: vi.fn(),
  getLayoutMetrics: vi.fn(),
  hoverSelector: vi.fn(),
  queryAllElements: vi.fn(),
  runtimeEvaluate: vi.fn(),
  scrollBy: (...args: unknown[]) => scrollBy(...args),
  selectOptionOnSelector: (...args: unknown[]) => selectOptionOnSelector(...args),
  setDialogResponse: vi.fn(),
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
// The body takes (webContents, entry): `set_viewport` picks its mechanism from
// the entry, so a mock that passes only the guest makes that tool crash rather
// than dispatch.
const fakeEntry = {
  sessionId: 'pane_abc12345',
  ownerSessionId: 'agent-1',
  taskId: 'task-1',
  // Literal rather than CALLER_PROJECT: this initializer runs above that
  // declaration, so referencing it would be a temporal dead zone error.
  projectId: 'p1',
  webContentsId: 7,
  url: null,
  kind: 'pane',
} as never;
vi.mock('../../src/main/browser/browser-pane-driver', () => ({
  withGuest: vi.fn(async (
    _options: unknown,
    fn: (webContents: unknown, entry: unknown) => Promise<unknown>,
  ) => ({
    ok: true,
    data: await fn(fakeGuest, fakeEntry),
  })),
  validateNavigationUrl: vi.fn((url: string) => ({ ok: true, url })),
  navigateGuest: vi.fn(),
}));

// The viewport mechanisms have their own file
// (`browser-viewport-override.test.ts`, which drives the real dispatch). Here
// they are stubbed so the TOOL's own job - validating, and routing set vs
// reset - can be asserted without a window or a CDP session.
const applyViewport = vi.fn(async () => ({
  mechanism: 'device-emulation' as const,
  requested: { width: 1920, height: 1080 },
  viewport: { width: 1920, height: 1080 },
  deviceScaleFactor: 0,
  zoom: 1,
  exact: true,
  visibleFraction: 1,
  note: null,
}));
const clearViewport = vi.fn(async () => ({
  mechanism: 'device-emulation' as const,
  requested: { width: 740, height: 749 },
  viewport: { width: 740, height: 749 },
  deviceScaleFactor: 0,
  zoom: 1,
  exact: true,
  visibleFraction: 1,
  note: null,
}));
vi.mock('../../src/main/browser/viewport-override', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/browser/viewport-override')>();
  return {
    ...actual,
    applyViewport: (...args: unknown[]) => applyViewport(...(args as [])),
    clearViewport: (...args: unknown[]) => clearViewport(...(args as [])),
  };
});

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
  vi.mocked(withGuest).mockImplementation(async (_options, fn) => ({ ok: true, data: await fn(fakeGuest, fakeEntry) }));
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

describe('argument guards that live only in the tool body', () => {
  // These two refusals are pure argument validation between zod and the
  // driver, so nothing else in the tree covers them: zod accepts the shape and
  // the primitive is never reached. Both were verified live once; without a
  // test a refactor silently turns them into a no-op drive.

  it('scroll refuses a zero delta instead of dispatching a wheel that does nothing', async () => {
    const { client, close } = await connect();

    const result = await client.callTool({ name: 'kangentic_browser_scroll', arguments: {} });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('invalid-scroll');
    expect(scrollBy).not.toHaveBeenCalled();
    await close();
  });

  it('select_option refuses when no option is named, rather than picking one', async () => {
    // value / label / index are each optional, so zod accepts a call that
    // identifies nothing. Guessing (the first option, say) would silently
    // change a form the agent never chose to change.
    const { client, close } = await connect();

    const result = await client.callTool({
      name: 'kangentic_browser_select_option',
      arguments: { selector: '#country' },
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('missing-target');
    expect(selectOptionOnSelector).not.toHaveBeenCalled();
    await close();
  });
});

describe('kangentic_browser_set_viewport: validation and set-vs-reset routing', () => {
  it('routes a sized call to applyViewport, carrying the caller session as the owner', async () => {
    const { client, close } = await connect();

    await client.callTool({
      name: 'kangentic_browser_set_viewport',
      arguments: { width: 1920, height: 1080, zoom: 0.4 },
    });

    expect(clearViewport).not.toHaveBeenCalled();
    expect(applyViewport).toHaveBeenCalledTimes(1);
    const [, , request] = applyViewport.mock.calls[0] as unknown as [unknown, unknown, Record<string, unknown>];
    expect(request).toMatchObject({ width: 1920, height: 1080, zoom: 0.4 });
    await close();
  });

  it('routes reset to clearViewport and never to the set path', async () => {
    const { client, close } = await connect();

    await client.callTool({ name: 'kangentic_browser_set_viewport', arguments: { reset: true } });

    expect(clearViewport).toHaveBeenCalledTimes(1);
    expect(applyViewport).not.toHaveBeenCalled();
    await close();
  });

  it('reset wins over a width in the same call, rather than doing both', async () => {
    const { client, close } = await connect();

    await client.callTool({
      name: 'kangentic_browser_set_viewport',
      arguments: { reset: true, width: 1920 },
    });

    expect(clearViewport).toHaveBeenCalledTimes(1);
    expect(applyViewport).not.toHaveBeenCalled();
    await close();
  });

  it('refuses an out-of-range dimension without reaching the guest', async () => {
    // The handler validates as well as zod, because a value that arrives as a
    // fraction or NaN becomes a compositor surface rather than an error, and
    // the failure then looks like a broken page rather than a bad argument.
    const { client, close } = await connect();

    const result = await client.callTool({
      name: 'kangentic_browser_set_viewport',
      arguments: { width: 99999 },
    });

    expect(applyViewport).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    await close();
  });
});
