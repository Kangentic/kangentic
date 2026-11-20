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
 * Six behaviors pinned here:
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
 * 3. `kangentic_browser_click`'s `coordSpace: 'image'` path divides the given
 *    x/y by the screenshot's own capture density
 *    (`describeViewportCapture`'s `pixelsPerCssPixel`), falling back to the
 *    page's `deviceScaleFactor` only when no capture density is available,
 *    and refusing rather than dividing by nothing when neither is. A capture
 *    scaled to fit the pane or a byte budget holds fewer pixels than the
 *    page's own ratio, so dividing by the wrong one lands the click on the
 *    wrong element. It also asks `describeViewportCapture` for the CORRECT
 *    pane, not an unbounded one, since a null surface there would silently
 *    fall back to the page's own unbounded density.
 * 4. `kangentic_browser_screenshot`'s metadata carries the capture's own
 *    `pixelsPerCssPixel` (never a hardcoded 1) and the capture's `note` when
 *    one is present, and omits `note` when there is none to report.
 * 5. `kangentic_browser_screenshot_element` passes the pane's own surface to
 *    `captureElementClip`, exactly as the viewport screenshot does, so an
 *    element capture is planned to fit the pane rather than tiled by
 *    Chromium.
 * 6. `saveToFile` on eval, query_dom and both screenshots writes the result to the
 *    caller's capture folder and returns the path instead of the inline value
 *    (task #977). An agent needing large DOM and PNG captures as files drove
 *    Playwright MCP because these tools could only answer inline.
 * 7. Every tool that acts on one element by selector asks its primitive for a
 *    STRICT match unless the agent passed `strict: false`, an
 *    `ambiguous-selector` refusal reaches the agent with its candidates, and a
 *    click by x/y with no `coordSpace` says how it read them (GitHub #820). The
 *    match counting itself runs in the page and is pinned in
 *    `browser-actionable-matches.test.ts` and the e2e spec.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
// dispatchMouseEvent and getLayoutMetrics drive the click body's image-space
// coordinate mapping tested below.
const dispatchMouseEvent = vi.fn();
const getLayoutMetrics = vi.fn();
// clickAtCenterOfSelector and dispatchKeypress drive the keypress body's
// click-then-press path tested below. Every other CDP call in this file stays
// an untracked inline stub.
const clickAtCenterOfSelector = vi.fn();
const dispatchKeypress = vi.fn();
// hoverSelector, dragFromTo and dropFilesOnSelector are tracked for the
// strict-selector passthrough tested below.
const hoverSelector = vi.fn();
const dragFromTo = vi.fn();
const dropFilesOnSelector = vi.fn();
// runtimeEvaluate drives the eval body's saveToFile path tested below.
const runtimeEvaluate = vi.fn();
vi.mock('../../src/main/browser/cdp/cdp', () => ({
  clickAtCenterOfSelector: (...args: unknown[]) => clickAtCenterOfSelector(...args),
  dispatchMouseEvent: (...args: unknown[]) => dispatchMouseEvent(...args),
  dispatchKeyEvent: vi.fn(),
  dispatchKeypress: (...args: unknown[]) => dispatchKeypress(...args),
  dragFromTo: (...args: unknown[]) => dragFromTo(...args),
  dropFilesOnSelector: (...args: unknown[]) => dropFilesOnSelector(...args),
  getDialogEntries: vi.fn(() => []),
  getNetworkEntries: vi.fn(() => []),
  getOuterHtml: (...args: unknown[]) => getOuterHtml(...args),
  getBoundingBox: vi.fn(),
  getConsoleEntries: vi.fn(),
  getLayoutMetrics: (...args: unknown[]) => getLayoutMetrics(...args),
  hoverSelector: (...args: unknown[]) => hoverSelector(...args),
  queryAllElements: vi.fn(),
  runtimeEvaluate: (...args: unknown[]) => runtimeEvaluate(...args),
  scrollBy: (...args: unknown[]) => scrollBy(...args),
  selectOptionOnSelector: (...args: unknown[]) => selectOptionOnSelector(...args),
  setDialogResponse: vi.fn(),
  typeText: vi.fn(),
}));

const captureScreenshotWithBudget = vi.fn();
// describeViewportCapture drives the click body's image-space density lookup
// tested below; captureElementClip drives the screenshot_element surface
// passthrough tested below; the plain screenshot tests stay on
// captureScreenshotWithBudget alone.
const describeViewportCapture = vi.fn();
const captureElementClip = vi.fn();
vi.mock('../../src/main/browser/cdp/screenshot', () => ({
  captureScreenshotWithBudget: (...args: unknown[]) => captureScreenshotWithBudget(...args),
  captureElementClip: (...args: unknown[]) => captureElementClip(...args),
  describeViewportCapture: (...args: unknown[]) => describeViewportCapture(...args),
  // saveToFile prunes its folder before each write; the pruning has its own test.
  pruneShotsDir: vi.fn(),
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
  // What a mounted pane reports; the screenshot body bounds its capture by it.
  widgetSize: { width: 740, height: 749 },
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
  paneHeightFill: 1,
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
  paneHeightFill: 1,
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
import { getBoundingBox } from '../../src/main/browser/cdp/cdp';
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

async function connect(captureDirectory?: string, captureCopyDirectory?: string) {
  const browser: BrowserToolDependencies = {
    projectId: CALLER_PROJECT,
    ...(captureDirectory ? { captureDirectory: () => captureDirectory } : {}),
    ...(captureCopyDirectory ? { captureCopyDirectory: () => captureCopyDirectory } : {}),
  };
  const server = buildConfiguredMcpServer(makeResolver(), fakeTaskCounter, automationConfig, null, browser);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'drive-body-guard', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

beforeEach(() => {
  vi.clearAllMocks();
  clickAtCenterOfSelector.mockReset();
  dispatchKeypress.mockReset();
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
      pixelsPerCssPixel: 1,
      scale: 1,
      fullPage: false,
      elementClip: null,
      retries: 0,
      note: null,
    });
    const { client, close } = await connect();

    const result = await client.callTool({ name: 'kangentic_browser_screenshot', arguments: {} });

    expect(captureScreenshotWithBudget).toHaveBeenCalledTimes(1);
    // The pane's widget reaches the capture, so it is planned to fit the pane
    // instead of being tiled by Chromium.
    const [, options] = captureScreenshotWithBudget.mock.calls[0] as [unknown, { surface: unknown }];
    expect(options.surface).toEqual({ widget: { width: 740, height: 749 }, widgetSource: 'reported', displayScale: 1 });
    expect(result.isError).toBeUndefined();
    expect(result.content).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'image', mimeType: 'image/jpeg' })]),
    );
    // The density an image-space kangentic_browser_click divides by, carried
    // through even when it happens to equal 1, and no note key when the
    // capture reported none.
    expect(result.structuredContent).toMatchObject({ pixelsPerCssPixel: 1 });
    expect(result.structuredContent).not.toHaveProperty('note');
    await close();
  });

  it('carries a non-1 pixelsPerCssPixel and the downscale note when the capture reports them', async () => {
    // Regression guard for screenshotToolResult: the case above pins that a
    // note-less, 1:1 capture stays that way, and this one pins that a
    // downscaled capture's real density and reason both reach the metadata
    // rather than being dropped or hardcoded.
    detectDevServerError.mockResolvedValue(null);
    captureScreenshotWithBudget.mockResolvedValue({
      mode: 'inline',
      format: 'jpeg',
      base64: 'ZmFrZQ==',
      byteLength: 4,
      width: 342,
      height: 346,
      viewportWidth: 740,
      viewportHeight: 749,
      deviceScaleFactor: 2,
      metricsAvailable: true,
      pixelsPerCssPixel: 0.4625,
      scale: 1,
      fullPage: false,
      elementClip: null,
      retries: 0,
      note: 'Scaled down to fit the pane; resize the pane to capture at full resolution.',
    });
    const { client, close } = await connect();

    const result = await client.callTool({ name: 'kangentic_browser_screenshot', arguments: {} });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      pixelsPerCssPixel: 0.4625,
      note: 'Scaled down to fit the pane; resize the pane to capture at full resolution.',
    });
    await close();
  });
});

describe('kangentic_browser_screenshot_element: pane surface passthrough', () => {
  it('passes the pane widget to captureElementClip, so an element capture is planned to fit the pane', async () => {
    // Mirrors the equivalent kangentic_browser_screenshot assertion above: an
    // element capture aims for up to 1:1, which is the case most likely to
    // exceed the pane, so a dropped surface here tiles exactly like a dropped
    // one on the viewport capture does.
    captureElementClip.mockResolvedValue({
      mode: 'inline',
      format: 'png',
      base64: 'ZmFrZQ==',
      byteLength: 4,
      width: 80,
      height: 40,
      viewportWidth: 740,
      viewportHeight: 749,
      deviceScaleFactor: 1,
      metricsAvailable: true,
      pixelsPerCssPixel: 1,
      scale: 1,
      fullPage: false,
      elementClip: { selector: '.thing', box: { x: 10, y: 20, width: 80, height: 40 } },
      retries: 0,
      note: null,
    });
    const { client, close } = await connect();

    const result = await client.callTool({
      name: 'kangentic_browser_screenshot_element',
      arguments: { selector: '.thing' },
    });

    expect(result.isError).toBeUndefined();
    expect(captureElementClip).toHaveBeenCalledTimes(1);
    const [webContentsArg, selectorArg, options] = captureElementClip.mock.calls[0] as [
      unknown,
      string,
      { surface: unknown },
    ];
    expect(webContentsArg).toBe(fakeGuest);
    expect(selectorArg).toBe('.thing');
    expect(options.surface).toEqual({ widget: { width: 740, height: 749 }, widgetSource: 'reported', displayScale: 1 });
    // The real captureElementClip response reaches the tool's metadata too.
    expect(result.structuredContent).toMatchObject({
      pixelsPerCssPixel: 1,
      elementClip: { selector: '.thing', box: { x: 10, y: 20, width: 80, height: 40 } },
    });
    await close();
  });
});

describe('saveToFile: a capture written to the caller\'s folder instead of inline', () => {
  const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const inlineShot = {
    mode: 'inline' as const,
    format: 'png' as const,
    base64: PNG_BYTES.toString('base64'),
    byteLength: PNG_BYTES.byteLength,
    width: 740,
    height: 749,
    viewportWidth: 740,
    viewportHeight: 749,
    deviceScaleFactor: 1,
    metricsAvailable: true,
    pixelsPerCssPixel: 1,
    scale: 1,
    fullPage: true,
    elementClip: null,
    retries: 0,
    note: null,
  };

  function captureFolder(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-browser-capture-'));
  }

  it('eval writes a string value as it is and returns its path and size, not the value', async () => {
    const folder = captureFolder();
    const html = '<html><body>' + 'x'.repeat(5000) + '</body></html>';
    runtimeEvaluate.mockResolvedValue({ value: html, error: null });
    const { client, close } = await connect(folder);

    const result = await client.callTool({
      name: 'kangentic_browser_eval',
      arguments: { expression: 'document.documentElement.outerHTML', saveToFile: true },
    });

    expect(result.isError).toBeUndefined();
    const data = result.structuredContent as { filePath: string; bytes: number; value?: unknown };
    expect(data.value).toBeUndefined();
    expect(path.dirname(data.filePath)).toBe(folder);
    expect(data.filePath).toMatch(/eval-.*\.txt$/);
    expect(fs.readFileSync(data.filePath, 'utf8')).toBe(html);
    expect(data.bytes).toBe(Buffer.byteLength(html));
    // The inline text never carries the value, which is the whole point.
    expect(JSON.stringify(result.content)).not.toContain('xxxxxxxxxx');
    await close();
    fs.rmSync(folder, { recursive: true, force: true });
  });

  it('eval writes a non-string value as JSON', async () => {
    const folder = captureFolder();
    runtimeEvaluate.mockResolvedValue({ value: { links: ['/a', '/b'] }, error: null });
    const { client, close } = await connect(folder);

    const result = await client.callTool({
      name: 'kangentic_browser_eval',
      arguments: { expression: 'collectLinks()', saveToFile: true },
    });

    const data = result.structuredContent as { filePath: string };
    expect(data.filePath).toMatch(/\.json$/);
    expect(JSON.parse(fs.readFileSync(data.filePath, 'utf8'))).toEqual({ links: ['/a', '/b'] });
    await close();
    fs.rmSync(folder, { recursive: true, force: true });
  });

  it('eval without saveToFile still returns the value inline', async () => {
    runtimeEvaluate.mockResolvedValue({ value: 42, error: null });
    const { client, close } = await connect(captureFolder());

    const result = await client.callTool({ name: 'kangentic_browser_eval', arguments: { expression: '6 * 7' } });

    expect(result.structuredContent).toEqual({ value: 42 });
    await close();
  });

  it('screenshot writes the pane-bounded capture with no inline budget and returns a resource link', async () => {
    const folder = captureFolder();
    detectDevServerError.mockResolvedValue(null);
    captureScreenshotWithBudget.mockResolvedValue(inlineShot);
    const { client, close } = await connect(folder);

    const result = await client.callTool({
      name: 'kangentic_browser_screenshot',
      arguments: { fullPage: true, format: 'png', maxBytes: 1000, saveToFile: true },
    });

    expect(result.isError).toBeUndefined();
    // Still planned to the pane's own pixels; only the inline byte budget is lifted.
    const options = captureScreenshotWithBudget.mock.calls[0][1] as { surface: unknown; maxBytes?: number; inlineCeiling?: number };
    expect(options.surface).toEqual({ widget: { width: 740, height: 749 }, widgetSource: 'reported', displayScale: 1 });
    expect(options.maxBytes).toBeUndefined();
    expect(options.inlineCeiling).toBe(Number.MAX_SAFE_INTEGER);
    const meta = result.structuredContent as { mode: string; reason: string; filePath: string };
    expect(meta).toMatchObject({ mode: 'file', reason: 'requested' });
    expect(path.dirname(meta.filePath)).toBe(folder);
    expect(meta.filePath).toMatch(/screenshot-.*\.png$/);
    expect(fs.readFileSync(meta.filePath).equals(PNG_BYTES)).toBe(true);
    expect(result.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'resource_link' })]));
    expect(result.content).not.toEqual(expect.arrayContaining([expect.objectContaining({ type: 'image' })]));
    await close();
    fs.rmSync(folder, { recursive: true, force: true });
  });

  it('query_dom writes the outerHTML at the observe tier, so a DOM capture needs no eval', async () => {
    const folder = captureFolder();
    const html = '<html><body><main>' + 'y'.repeat(5000) + '</main></body></html>';
    getOuterHtml.mockResolvedValue(html);
    const { client, close } = await connect(folder);

    const result = await client.callTool({ name: 'kangentic_browser_query_dom', arguments: { saveToFile: true } });

    expect(result.isError).toBeUndefined();
    const data = result.structuredContent as { selector: string; filePath: string; bytes: number; outerHTML?: string };
    expect(data.outerHTML).toBeUndefined();
    expect(data.selector).toBe('html');
    expect(data.filePath).toMatch(/dom-.*\.html$/);
    expect(path.dirname(data.filePath)).toBe(folder);
    expect(fs.readFileSync(data.filePath, 'utf8')).toBe(html);
    expect(vi.mocked(withGuest).mock.calls[0][0]).toMatchObject({ capability: 'observe' });
    await close();
    fs.rmSync(folder, { recursive: true, force: true });
  });

  it('screenshot_element writes its clip to the caller\'s folder', async () => {
    const folder = captureFolder();
    captureElementClip.mockResolvedValue({ ...inlineShot, fullPage: false, elementClip: { selector: 'main', box: { x: 0, y: 0, width: 740, height: 749 } } });
    const { client, close } = await connect(folder);

    const result = await client.callTool({
      name: 'kangentic_browser_screenshot_element',
      arguments: { selector: 'main', saveToFile: true },
    });

    const meta = result.structuredContent as { filePath: string };
    expect(path.dirname(meta.filePath)).toBe(folder);
    expect(meta.filePath).toMatch(/element-.*\.png$/);
    await close();
    fs.rmSync(folder, { recursive: true, force: true });
  });

  it('a jpeg screenshot is saved with a .jpg extension and its bytes round-trip', async () => {
    const folder = captureFolder();
    const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
    detectDevServerError.mockResolvedValue(null);
    captureScreenshotWithBudget.mockResolvedValue({
      ...inlineShot,
      format: 'jpeg' as const,
      base64: jpegBytes.toString('base64'),
      byteLength: jpegBytes.byteLength,
    });
    const { client, close } = await connect(folder);

    const result = await client.callTool({
      name: 'kangentic_browser_screenshot',
      arguments: { format: 'jpeg', saveToFile: true },
    });

    expect(result.isError).toBeUndefined();
    const meta = result.structuredContent as { filePath: string };
    expect(meta.filePath).toMatch(/screenshot-.*\.jpg$/);
    expect(fs.readFileSync(meta.filePath).equals(jpegBytes)).toBe(true);
    await close();
    fs.rmSync(folder, { recursive: true, force: true });
  });

  it('query_dom with includeBox and saveToFile keeps selector and box, adds filePath and bytes, and omits outerHTML', async () => {
    const folder = captureFolder();
    const html = '<main>' + 'z'.repeat(200) + '</main>';
    getOuterHtml.mockResolvedValue(html);
    vi.mocked(getBoundingBox).mockResolvedValue({ content: [10, 20, 110, 20, 110, 70, 10, 70] } as never);
    const { client, close } = await connect(folder);

    const result = await client.callTool({
      name: 'kangentic_browser_query_dom',
      arguments: { selector: 'main', includeBox: true, saveToFile: true },
    });

    expect(result.isError).toBeUndefined();
    const data = result.structuredContent as Record<string, unknown>;
    expect(data.selector).toBe('main');
    expect(data.box).toEqual({ x: 10, y: 20, width: 100, height: 50 });
    expect(data.bytes).toBe(Buffer.byteLength(html));
    expect(data).not.toHaveProperty('outerHTML');
    expect(fs.readFileSync(data.filePath as string, 'utf8')).toBe(html);
    await close();
    fs.rmSync(folder, { recursive: true, force: true });
  });

  it('writes under os.tmpdir()/kangentic-captures/<projectId> when no capture directory is supplied', async () => {
    const expectedFolder = path.join(os.tmpdir(), 'kangentic-captures', CALLER_PROJECT);
    runtimeEvaluate.mockResolvedValue({ value: 'fallback-value', error: null });
    const { client, close } = await connect();

    const result = await client.callTool({
      name: 'kangentic_browser_eval',
      arguments: { expression: '"fallback-value"', saveToFile: true },
    });

    const data = result.structuredContent as { filePath: string };
    try {
      expect(path.dirname(data.filePath)).toBe(expectedFolder);
      expect(fs.readFileSync(data.filePath, 'utf8')).toBe('fallback-value');
    } finally {
      fs.rmSync(data.filePath, { force: true });
      await close();
    }
  });

  // Claude Code saves every image block under its config folder, and copying it out of there
  // stops on a permission prompt (task #1136). A screenshot is also written to the caller's copies
  // folder, so the agent has a path it can copy with no prompt.
  describe('a screenshot also names a copy in the caller\'s folder', () => {
    // Cleanup runs here, not at the end of each test, so a failing assertion leaks no folder and
    // leaves no client open.
    const createdFolders: string[] = [];
    let closeConnection: (() => Promise<void>) | null = null;

    function copyTestFolder(): string {
      const folder = captureFolder();
      createdFolders.push(folder);
      return folder;
    }

    async function connectForCopy(captureDirectory?: string, captureCopyDirectory?: string) {
      const connection = await connect(captureDirectory, captureCopyDirectory);
      closeConnection = connection.close;
      return connection.client;
    }

    afterEach(async () => {
      await closeConnection?.();
      closeConnection = null;
      for (const folder of createdFolders.splice(0)) fs.rmSync(folder, { recursive: true, force: true });
    });

    it('screenshot keeps the image and writes the same bytes to the copy folder', async () => {
      const folder = copyTestFolder();
      detectDevServerError.mockResolvedValue(null);
      captureScreenshotWithBudget.mockResolvedValue(inlineShot);
      const client = await connectForCopy(undefined, folder);

      const result = await client.callTool({ name: 'kangentic_browser_screenshot', arguments: { format: 'png' } });

      expect(result.isError).toBeUndefined();
      expect(result.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'image', data: inlineShot.base64 })]));
      const meta = result.structuredContent as { mode: string; filePath: string; location: string };
      expect(meta).toMatchObject({ mode: 'inline', location: 'local' });
      expect(path.dirname(meta.filePath)).toBe(folder);
      expect(meta.filePath).toMatch(/screenshot-.*\.png$/);
      expect(fs.readFileSync(meta.filePath).equals(PNG_BYTES)).toBe(true);
      // The capture budget is untouched: the copy is the inline image, not a save.
      const options = captureScreenshotWithBudget.mock.calls[0][1] as { inlineCeiling?: number };
      expect(options.inlineCeiling).toBeUndefined();
    });

    it('screenshot_element names its copy with the element prefix', async () => {
      const folder = copyTestFolder();
      captureElementClip.mockResolvedValue({ ...inlineShot, fullPage: false, elementClip: { selector: 'main', box: { x: 0, y: 0, width: 740, height: 749 } } });
      const client = await connectForCopy(undefined, folder);

      const result = await client.callTool({ name: 'kangentic_browser_screenshot_element', arguments: { selector: 'main' } });

      const meta = result.structuredContent as { filePath: string };
      expect(path.dirname(meta.filePath)).toBe(folder);
      expect(meta.filePath).toMatch(/element-.*\.png$/);
    });

    it('copies a capture past the inline ceiling out of the inspected checkout, and names the copy', async () => {
      const folder = copyTestFolder();
      const elsewhere = copyTestFolder();
      const persisted = path.join(elsewhere, 'devtools-shots', 'shot.png');
      fs.mkdirSync(path.dirname(persisted), { recursive: true });
      fs.writeFileSync(persisted, PNG_BYTES);
      detectDevServerError.mockResolvedValue(null);
      const { base64: _unused, ...fields } = inlineShot;
      captureScreenshotWithBudget.mockResolvedValue({ ...fields, mode: 'file', filePath: persisted, fileUri: 'file:///unused', reason: 'over-inline-ceiling' });
      const client = await connectForCopy(undefined, folder);

      const result = await client.callTool({ name: 'kangentic_browser_screenshot', arguments: { format: 'png' } });

      const meta = result.structuredContent as { mode: string; filePath: string; reason: string };
      expect(meta).toMatchObject({ mode: 'file', reason: 'over-inline-ceiling' });
      expect(path.dirname(meta.filePath)).toBe(folder);
      expect(fs.readFileSync(meta.filePath).equals(PNG_BYTES)).toBe(true);
    });

    it('names no file when there is no copy folder (a remote project)', async () => {
      detectDevServerError.mockResolvedValue(null);
      captureScreenshotWithBudget.mockResolvedValue(inlineShot);
      const client = await connectForCopy(copyTestFolder());

      const result = await client.callTool({ name: 'kangentic_browser_screenshot', arguments: {} });

      expect(result.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'image' })]));
      expect(result.structuredContent).not.toHaveProperty('filePath');
      expect(result.structuredContent).not.toHaveProperty('location');
    });

    it('still returns the image when the copy cannot be written', async () => {
      const blocker = copyTestFolder();
      const blockerFile = path.join(blocker, 'not-a-directory');
      fs.writeFileSync(blockerFile, 'file');
      detectDevServerError.mockResolvedValue(null);
      captureScreenshotWithBudget.mockResolvedValue(inlineShot);
      const client = await connectForCopy(undefined, path.join(blockerFile, 'captures'));

      const result = await client.callTool({ name: 'kangentic_browser_screenshot', arguments: {} });

      expect(result.isError).toBeUndefined();
      expect(result.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'image' })]));
      expect(result.structuredContent).not.toHaveProperty('filePath');
    });

    it('names a jpeg copy with a .jpg extension', async () => {
      const folder = copyTestFolder();
      const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
      detectDevServerError.mockResolvedValue(null);
      captureScreenshotWithBudget.mockResolvedValue({
        ...inlineShot,
        format: 'jpeg' as const,
        base64: jpegBytes.toString('base64'),
        byteLength: jpegBytes.byteLength,
      });
      const client = await connectForCopy(undefined, folder);

      const result = await client.callTool({ name: 'kangentic_browser_screenshot', arguments: { format: 'jpeg' } });

      const meta = result.structuredContent as { mode: string; filePath: string };
      expect(meta.mode).toBe('inline');
      expect(meta.filePath).toMatch(/screenshot-.*\.jpg$/);
      expect(path.dirname(meta.filePath)).toBe(folder);
      expect(fs.readFileSync(meta.filePath).equals(jpegBytes)).toBe(true);
    });

    describe('a file-mode capture that gets no copy keeps its original path', () => {
      async function captureFileMode(originalPath: string, copyFolder: string) {
        detectDevServerError.mockResolvedValue(null);
        const { base64: _unused, ...fields } = inlineShot;
        captureScreenshotWithBudget.mockResolvedValue({ ...fields, mode: 'file', filePath: originalPath, fileUri: 'file:///original', reason: 'over-inline-ceiling' });
        const client = await connectForCopy(undefined, copyFolder);
        return client.callTool({ name: 'kangentic_browser_screenshot', arguments: { format: 'png' } });
      }

      it('when the file under devtools-shots is missing', async () => {
        const root = copyTestFolder();
        const copyFolder = path.join(root, 'copies-target');
        const missing = path.join(root, 'devtools-shots', 'gone.png');
        fs.mkdirSync(path.dirname(missing), { recursive: true });

        const result = await captureFileMode(missing, copyFolder);

        expect(result.isError).toBeUndefined();
        expect(result.structuredContent).toMatchObject({ mode: 'file', filePath: missing, fileUri: 'file:///original' });
        expect(fs.existsSync(copyFolder)).toBe(false);
      });

      it('when the real file is not under a devtools-shots folder', async () => {
        const root = copyTestFolder();
        const copyFolder = path.join(root, 'copies-target');
        const elsewhere = path.join(root, 'other-folder', 'shot.png');
        fs.mkdirSync(path.dirname(elsewhere), { recursive: true });
        fs.writeFileSync(elsewhere, PNG_BYTES);

        const result = await captureFileMode(elsewhere, copyFolder);

        expect(result.isError).toBeUndefined();
        expect(result.structuredContent).toMatchObject({ mode: 'file', filePath: elsewhere, fileUri: 'file:///original' });
        expect(fs.existsSync(copyFolder)).toBe(false);
      });
    });
  });

  describe('a folder that cannot be created reports save-failed', () => {
    let blockerDirectory: string;
    let unwritableFolder: string;

    beforeEach(() => {
      // A regular file in the way: a folder cannot be created beneath it.
      blockerDirectory = captureFolder();
      const blockerFile = path.join(blockerDirectory, 'not-a-directory');
      fs.writeFileSync(blockerFile, 'file');
      unwritableFolder = path.join(blockerFile, 'captures');
    });

    function expectSaveFailed(result: Awaited<ReturnType<Awaited<ReturnType<typeof connect>>['client']['callTool']>>): void {
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ error: { kind: 'save-failed' } });
      const detail = (result.structuredContent as { error: { detail: string } }).error.detail;
      expect(detail).toContain('could not be written');
      fs.rmSync(blockerDirectory, { recursive: true, force: true });
    }

    it('screenshot', async () => {
      detectDevServerError.mockResolvedValue(null);
      captureScreenshotWithBudget.mockResolvedValue(inlineShot);
      const { client, close } = await connect(unwritableFolder);

      expectSaveFailed(await client.callTool({ name: 'kangentic_browser_screenshot', arguments: { saveToFile: true } }));
      await close();
    });

    it('screenshot_element', async () => {
      captureElementClip.mockResolvedValue({ ...inlineShot, fullPage: false, elementClip: { selector: 'main', box: { x: 0, y: 0, width: 1, height: 1 } } });
      const { client, close } = await connect(unwritableFolder);

      expectSaveFailed(await client.callTool({ name: 'kangentic_browser_screenshot_element', arguments: { selector: 'main', saveToFile: true } }));
      await close();
    });

    it('query_dom', async () => {
      getOuterHtml.mockResolvedValue('<html></html>');
      const { client, close } = await connect(unwritableFolder);

      expectSaveFailed(await client.callTool({ name: 'kangentic_browser_query_dom', arguments: { saveToFile: true } }));
      await close();
    });

    it('eval', async () => {
      runtimeEvaluate.mockResolvedValue({ value: 'x', error: null });
      const { client, close } = await connect(unwritableFolder);

      expectSaveFailed(await client.callTool({ name: 'kangentic_browser_eval', arguments: { expression: '"x"', saveToFile: true } }));
      await close();
    });
  });
});

describe('kangentic_browser_click: image-space coordinate mapping', () => {
  // coordSpace: 'image' maps a point off a full-viewport screenshot back to
  // the page. A screenshot scaled to fit the pane or a byte budget holds
  // fewer pixels than the page's own deviceScaleFactor implies, so the
  // mapping must divide by the CAPTURE's density when one is known, and only
  // fall back to the page's deviceScaleFactor when it is not.

  it('divides by the capture density rather than the page deviceScaleFactor when both are available', async () => {
    describeViewportCapture.mockResolvedValue({
      image: { width: 370, height: 375 },
      pixelsPerCssPixel: 0.5,
    });
    getLayoutMetrics.mockResolvedValue({
      viewportWidth: 740,
      viewportHeight: 749,
      deviceScaleFactor: 2,
      contentWidth: 740,
      contentHeight: 749,
    });
    const { client, close } = await connect();

    const result = await client.callTool({
      name: 'kangentic_browser_click',
      arguments: { x: 100, y: 200, coordSpace: 'image' },
    });

    expect(result.isError).toBeUndefined();
    // An explicit coordSpace is the agent saying how to read x/y, so no warning.
    expect(result.structuredContent).not.toHaveProperty('warning');
    // 100 / 0.5 and 200 / 0.5, never 100 / 2 and 200 / 2: dividing by the
    // page's deviceScaleFactor here would land the click on the wrong element.
    expect(dispatchMouseEvent).toHaveBeenNthCalledWith(1, fakeGuest, { type: 'mousePressed', x: 200, y: 400 });
    expect(dispatchMouseEvent).toHaveBeenNthCalledWith(2, fakeGuest, { type: 'mouseReleased', x: 200, y: 400 });
    // The density lookup itself is asked about THIS pane, never an unbounded
    // one - a null surface here would silently widen to the page's own
    // density instead of the capture's, which is exactly the bug this test
    // guards against one layer up.
    expect(describeViewportCapture).toHaveBeenCalledWith(fakeGuest, {
      widget: { width: 740, height: 749 },
      widgetSource: 'reported',
      displayScale: 1,
    });
    // The page's deviceScaleFactor is a fallback, not a second source to
    // average or prefer, so it is never even read once a capture density
    // answers the question.
    expect(getLayoutMetrics).not.toHaveBeenCalled();
    await close();
  });

  it('falls back to the page deviceScaleFactor when the capture reports no density', async () => {
    describeViewportCapture.mockResolvedValue(null);
    getLayoutMetrics.mockResolvedValue({
      viewportWidth: 740,
      viewportHeight: 749,
      deviceScaleFactor: 2,
      contentWidth: 740,
      contentHeight: 749,
    });
    const { client, close } = await connect();

    const result = await client.callTool({
      name: 'kangentic_browser_click',
      arguments: { x: 100, y: 200, coordSpace: 'image' },
    });

    expect(result.isError).toBeUndefined();
    expect(dispatchMouseEvent).toHaveBeenNthCalledWith(1, fakeGuest, { type: 'mousePressed', x: 50, y: 100 });
    expect(dispatchMouseEvent).toHaveBeenNthCalledWith(2, fakeGuest, { type: 'mouseReleased', x: 50, y: 100 });
    await close();
  });

  it('returns coord-mapping-failed and dispatches nothing when neither density is available', async () => {
    describeViewportCapture.mockResolvedValue(null);
    getLayoutMetrics.mockResolvedValue(null);
    const { client, close } = await connect();

    const result = await client.callTool({
      name: 'kangentic_browser_click',
      arguments: { x: 100, y: 200, coordSpace: 'image' },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: { kind: 'coord-mapping-failed' } });
    expect(dispatchMouseEvent).not.toHaveBeenCalled();
    await close();
  });

  it('warns how it read x/y when coordSpace is omitted, and still clicks at them as viewport pixels', async () => {
    // A point off a HiDPI screenshot read as viewport pixels lands somewhere
    // else, and a click on a modal's backdrop closes the modal (GitHub #820).
    // The click is unchanged, so a caller passing real viewport pixels keeps
    // working; the result says what happened.
    const { client, close } = await connect();

    const result = await client.callTool({ name: 'kangentic_browser_click', arguments: { x: 100, y: 200 } });

    expect(result.isError).toBeUndefined();
    expect(dispatchMouseEvent).toHaveBeenNthCalledWith(1, fakeGuest, { type: 'mousePressed', x: 100, y: 200 });
    const structured = result.structuredContent as { warning?: string };
    expect(structured.warning).toContain('coordSpace: "image"');
    expect(structured.warning).toContain('pixelsPerCssPixel');
    // The text block is what most agents read, so the warning must be there too.
    expect(JSON.stringify(result.content)).toContain('coordSpace');
    await close();
  });

  it('carries no warning when coordSpace is viewport', async () => {
    const { client, close } = await connect();

    const result = await client.callTool({
      name: 'kangentic_browser_click',
      arguments: { x: 100, y: 200, coordSpace: 'viewport' },
    });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).not.toHaveProperty('warning');
    await close();
  });
});

describe('strict selector matching reaches every single-element tool (GitHub #820)', () => {
  // The counting runs in the page. What these pin is that each tool ASKS for
  // it by default and stops asking only when the agent says strict: false, so
  // a tool added to the family or refactored cannot quietly go back to acting
  // on whichever match came first.

  it('click asks for a strict match by default and a loose one when strict is false', async () => {
    clickAtCenterOfSelector.mockResolvedValue(true);
    const { client, close } = await connect();

    await client.callTool({ name: 'kangentic_browser_click', arguments: { selector: 'text="Save"' } });
    await client.callTool({ name: 'kangentic_browser_click', arguments: { selector: 'text="Save"', strict: false } });

    expect(clickAtCenterOfSelector).toHaveBeenNthCalledWith(1, fakeGuest, 'text="Save"', { strict: true });
    expect(clickAtCenterOfSelector).toHaveBeenNthCalledWith(2, fakeGuest, 'text="Save"', { strict: false });
    await close();
  });

  it('type, keypress, hover, drag, scroll, select_option and drop_files ask for a strict match by default', async () => {
    clickAtCenterOfSelector.mockResolvedValue(true);
    dispatchKeypress.mockResolvedValue(true);
    hoverSelector.mockResolvedValue(true);
    dragFromTo.mockResolvedValue(true);
    scrollBy.mockResolvedValue(true);
    getLayoutMetrics.mockResolvedValue(null);
    selectOptionOnSelector.mockResolvedValue({ ok: true, value: 'a' });
    dropFilesOnSelector.mockResolvedValue(true);
    const { client, close } = await connect();

    await client.callTool({ name: 'kangentic_browser_type', arguments: { text: 'x', selector: '#field' } });
    await client.callTool({ name: 'kangentic_browser_keypress', arguments: { keys: 'Enter', selector: '#field' } });
    await client.callTool({ name: 'kangentic_browser_hover', arguments: { selector: '#menu' } });
    await client.callTool({ name: 'kangentic_browser_drag', arguments: { fromSelector: '#a', toSelector: '#b' } });
    await client.callTool({ name: 'kangentic_browser_scroll', arguments: { selector: '#list', deltaY: 100 } });
    await client.callTool({ name: 'kangentic_browser_select_option', arguments: { selector: '#pick', value: 'a' } });
    await client.callTool({ name: 'kangentic_browser_drop_files', arguments: { selector: '#zone', paths: ['/tmp/a.txt'] } });

    expect(clickAtCenterOfSelector).toHaveBeenNthCalledWith(1, fakeGuest, '#field', { strict: true });
    expect(clickAtCenterOfSelector).toHaveBeenNthCalledWith(2, fakeGuest, '#field', { strict: true });
    expect(hoverSelector).toHaveBeenCalledWith(fakeGuest, '#menu', { strict: true });
    expect(dragFromTo).toHaveBeenCalledWith(fakeGuest, '#a', '#b', { steps: undefined, strict: true });
    expect(scrollBy).toHaveBeenCalledWith(fakeGuest, { selector: '#list', deltaX: undefined, deltaY: 100, strict: true });
    expect(selectOptionOnSelector).toHaveBeenCalledWith(fakeGuest, '#pick', { value: 'a', label: undefined, index: undefined }, { strict: true });
    expect(dropFilesOnSelector).toHaveBeenCalledWith(fakeGuest, '#zone', ['/tmp/a.txt'], { strict: true });
    await close();
  });

  it('type, keypress, hover, drag, scroll, select_option and drop_files pass strict: false through when the agent asks', async () => {
    clickAtCenterOfSelector.mockResolvedValue(true);
    dispatchKeypress.mockResolvedValue(true);
    hoverSelector.mockResolvedValue(true);
    dragFromTo.mockResolvedValue(true);
    scrollBy.mockResolvedValue(true);
    getLayoutMetrics.mockResolvedValue(null);
    selectOptionOnSelector.mockResolvedValue({ ok: true, value: 'a' });
    dropFilesOnSelector.mockResolvedValue(true);
    const { client, close } = await connect();

    await client.callTool({ name: 'kangentic_browser_type', arguments: { text: 'x', selector: '#field', strict: false } });
    await client.callTool({ name: 'kangentic_browser_keypress', arguments: { keys: 'Enter', selector: '#field', strict: false } });
    await client.callTool({ name: 'kangentic_browser_hover', arguments: { selector: '#menu', strict: false } });
    await client.callTool({ name: 'kangentic_browser_drag', arguments: { fromSelector: '#a', toSelector: '#b', strict: false } });
    await client.callTool({ name: 'kangentic_browser_scroll', arguments: { selector: '#list', deltaY: 100, strict: false } });
    await client.callTool({ name: 'kangentic_browser_select_option', arguments: { selector: '#pick', value: 'a', strict: false } });
    await client.callTool({ name: 'kangentic_browser_drop_files', arguments: { selector: '#zone', paths: ['/tmp/a.txt'], strict: false } });

    expect(clickAtCenterOfSelector).toHaveBeenNthCalledWith(1, fakeGuest, '#field', { strict: false });
    expect(clickAtCenterOfSelector).toHaveBeenNthCalledWith(2, fakeGuest, '#field', { strict: false });
    expect(hoverSelector).toHaveBeenCalledWith(fakeGuest, '#menu', { strict: false });
    expect(dragFromTo).toHaveBeenCalledWith(fakeGuest, '#a', '#b', { steps: undefined, strict: false });
    expect(scrollBy).toHaveBeenCalledWith(fakeGuest, { selector: '#list', deltaX: undefined, deltaY: 100, strict: false });
    expect(selectOptionOnSelector).toHaveBeenCalledWith(fakeGuest, '#pick', { value: 'a', label: undefined, index: undefined }, { strict: false });
    expect(dropFilesOnSelector).toHaveBeenCalledWith(fakeGuest, '#zone', ['/tmp/a.txt'], { strict: false });
    await close();
  });

  it('hands an ambiguous-selector refusal to the agent with its candidates, in both result blocks', async () => {
    const candidates = [
      { index: 0, tag: 'button', text: 'Save', id: null, role: null, ariaLabel: null, name: null, inDialog: false, topmost: false, box: { x: 10, y: 10, width: 60, height: 24 }, selector: 'html > body > form > button' },
      { index: 1, tag: 'button', text: 'Save', id: 'modal-save', role: null, ariaLabel: null, name: null, inDialog: true, topmost: true, box: { x: 300, y: 200, width: 60, height: 24 }, selector: '#modal-save' },
    ];
    vi.mocked(withGuest).mockResolvedValueOnce({
      ok: false,
      error: { kind: 'ambiguous-selector', detail: '2 visible elements match text="Save".', total: 2, candidates },
    });
    const { client, close } = await connect();

    const result = await client.callTool({ name: 'kangentic_browser_click', arguments: { selector: 'text="Save"' } });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: { kind: 'ambiguous-selector', total: 2, candidates } });
    expect(JSON.stringify(result.content)).toContain('#modal-save');
    await close();
  });
});

describe('kangentic_browser_keypress: an optional selector clicks first, in the same call', () => {
  // A key goes to whatever holds keyboard focus, and between an agent's calls
  // that is usually the user's terminal (task #720). The only configuration
  // that measured clean is the click and the key inside ONE call, which is what
  // the selector buys. The refusal of an unfocused key lives in `cdp.ts` and is
  // pinned in `browser-keyboard-focus.test.ts`.

  it('clicks the selector, THEN presses the key', async () => {
    clickAtCenterOfSelector.mockResolvedValue(true);
    dispatchKeypress.mockResolvedValue(true);
    const { client, close } = await connect();

    const result = await client.callTool({
      name: 'kangentic_browser_keypress',
      arguments: { keys: 'Escape', selector: '#demo-frame' },
    });

    expect(result.isError).toBeFalsy();
    expect(clickAtCenterOfSelector).toHaveBeenCalledWith(fakeGuest, '#demo-frame', { strict: true });
    expect(dispatchKeypress).toHaveBeenCalledWith(fakeGuest, 'Escape');
    expect(clickAtCenterOfSelector.mock.invocationCallOrder[0])
      .toBeLessThan(dispatchKeypress.mock.invocationCallOrder[0]);
    await close();
  });

  it('presses nothing when the selector matches nothing', async () => {
    clickAtCenterOfSelector.mockResolvedValue(false);
    const { client, close } = await connect();

    const result = await client.callTool({
      name: 'kangentic_browser_keypress',
      arguments: { keys: 'Escape', selector: '#missing' },
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('selector-not-found');
    expect(dispatchKeypress).not.toHaveBeenCalled();
    await close();
  });

  it('refuses an unparseable combo BEFORE clicking, so a typo in keys costs the page nothing', async () => {
    const { client, close } = await connect();

    const result = await client.callTool({
      name: 'kangentic_browser_keypress',
      arguments: { keys: 'Hyper+Enter', selector: '#demo-frame' },
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('unknown-key');
    expect(clickAtCenterOfSelector).not.toHaveBeenCalled();
    expect(withGuest).not.toHaveBeenCalled();
    await close();
  });

  it('clicks nothing without a selector', async () => {
    dispatchKeypress.mockResolvedValue(true);
    const { client, close } = await connect();

    const result = await client.callTool({ name: 'kangentic_browser_keypress', arguments: { keys: 'Enter' } });

    expect(result.isError).toBeFalsy();
    expect(clickAtCenterOfSelector).not.toHaveBeenCalled();
    expect(dispatchKeypress).toHaveBeenCalledWith(fakeGuest, 'Enter');
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
