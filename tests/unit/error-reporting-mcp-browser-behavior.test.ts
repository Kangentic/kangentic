/**
 * What a user loses if these reports go quiet: a broken MCP tool or a broken Browser
 * pane drive reaches nobody but the agent that called it. The SDK turns a tool's
 * throw into an error result, `runHandler` turns a command handler's throw into
 * `{ success: false }`, and the browser driver turns a throw into an error envelope,
 * so without a report Sentry never hears of a defect in any of them.
 *
 * Each case here RUNS the real code, drives the catch with a throwing dependency and
 * asserts what reached `reportHandledError` and with which tags. It replaces the
 * source-text pins in error-reporting-chokepoints.test.ts for `runHandler`, both
 * request stages of the HTTP server, the three server builders' `withToolReporting`
 * wrap, and the browser driver's three reports. A screenshot that times out, and one
 * refused as larger than its pane, run the real capture path, so their extra tags are
 * checked where the report is sent.
 *
 * A TypeError is the defect. A RefusalError is the expected failure that must send
 * nothing, so a case with it proves the filter is in the path rather than bypassed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const { reportHandledError, commandFault, buildFault, transportFault, queueFault } = vi.hoisted(() => ({
  reportHandledError: vi.fn(),
  commandFault: { error: null as unknown },
  buildFault: { error: null as unknown },
  transportFault: { error: null as unknown },
  queueFault: { error: null as unknown },
}));

vi.mock('../../src/main/analytics/error-reporting', () => ({ reportHandledError }));

vi.mock('electron', () => ({
  webContents: { fromId: vi.fn() },
  BrowserWindow: { fromWebContents: vi.fn(() => null) },
  app: { getPath: () => '/tmp', isPackaged: false, commandLine: { getSwitchValue: vi.fn(() => '') } },
}));

// runHandler's dependency: the one handler throws whatever the test armed.
vi.mock('../../src/main/agent/commands', () => ({
  commandHandlers: {
    explode: () => {
      throw commandFault.error;
    },
  },
}));

// The HTTP server's tool families are replaced by two probes, so a builder can be
// run for real and a tool callback made to throw. The first family of each builder
// registers one; `buildFault` makes a builder itself throw (the "request" stage).
function registerProbe(server: McpServer, name: string): void {
  server.registerTool(
    name,
    { description: 'probe', annotations: { readOnlyHint: true } },
    async () => {
      throw commandFault.error;
    },
  );
}
vi.mock('../../src/main/agent/mcp-http/task-tools', () => ({
  registerTaskTools: (server: McpServer) => {
    if (buildFault.error) throw buildFault.error;
    registerProbe(server, 'kangentic_probe_task');
  },
}));
vi.mock('../../src/main/agent/mcp-http/search-tools', () => ({
  registerSearchTools: (server: McpServer) => registerProbe(server, 'kangentic_probe_search'),
}));
vi.mock('../../src/main/agent/mcp-http/profile-tools', () => ({ registerProfileTools: vi.fn() }));
vi.mock('../../src/main/agent/mcp-http/automation-tools', () => ({ registerAutomationTools: vi.fn() }));
vi.mock('../../src/main/agent/mcp-http/workflow-tools', () => ({ registerWorkflowTools: vi.fn() }));
vi.mock('../../src/main/agent/mcp-http/session-tools', () => ({ registerSessionTools: vi.fn() }));
vi.mock('../../src/main/agent/mcp-http/project-tools', () => ({ registerProjectTools: vi.fn() }));
vi.mock('../../src/main/agent/mcp-http/usage-tools', () => ({ registerUsageTools: vi.fn() }));
vi.mock('../../src/main/agent/mcp-http/diagnostics-tools', () => ({ registerDiagnosticsTools: vi.fn() }));
vi.mock('../../src/main/agent/mcp-http/browser-tools', () => ({ registerBrowserTools: vi.fn() }));
vi.mock('../../src/main/agent/mcp-http/steering-tools', () => ({ registerSteeringTools: vi.fn() }));
vi.mock('../../src/main/agent/mcp-http/background-shell-tools', () => ({ registerBackgroundShellTools: vi.fn() }));
vi.mock('../../src/devtools/mcp/register', () => ({ registerDevtoolsMcpTools: vi.fn() }));

// The SDK transport is real except that a test can make `handleRequest` throw, which
// is the only way to reach the "dispatch" stage of a real request.
vi.mock('@modelcontextprotocol/sdk/server/streamableHttp.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@modelcontextprotocol/sdk/server/streamableHttp.js')>();
  class FaultableTransport extends actual.StreamableHTTPServerTransport {
    async handleRequest(...handleArguments: Parameters<InstanceType<typeof actual.StreamableHTTPServerTransport>['handleRequest']>): Promise<void> {
      if (transportFault.error) throw transportFault.error;
      return super.handleRequest(...handleArguments);
    }
  }
  return { ...actual, StreamableHTTPServerTransport: FaultableTransport };
});

// The browser driver's drive lock is real except that a test can make acquiring it fail.
vi.mock('../../src/main/browser/guest-drive-queue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/browser/guest-drive-queue')>();
  return {
    ...actual,
    withGuestDriveLock: (...lockArguments: Parameters<typeof actual.withGuestDriveLock>) => (
      queueFault.error ? Promise.reject(queueFault.error) : actual.withGuestDriveLock(...lockArguments)
    ),
  };
});

vi.mock('../../src/main/browser/cdp/cdp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/browser/cdp/cdp')>()),
  attachDebugger: vi.fn(() => true),
  isDebuggerAttached: vi.fn(() => false),
  detachDebugger: vi.fn(),
  ensureFocusEmulation: vi.fn(),
  waitForDialogInterception: vi.fn(async () => {}),
  ensureVirtualAuthenticator: vi.fn(async () => true),
  dismissedBeforeunloadSince: vi.fn(() => false),
  getDialogResponse: vi.fn(),
  // The session's record of a viewport override, which a test sets to say one is active.
  getDeviceMetrics: vi.fn(() => null),
}));

import { app, BrowserWindow, webContents } from 'electron';
import { attachDebugger, getDeviceMetrics, isDebuggerAttached, SCREENSHOT_TIMEOUT_MS } from '../../src/main/browser/cdp/cdp';
import { captureScreenshotWithBudget } from '../../src/main/browser/cdp/screenshot';
import { noteWake, resetWakeClockForTests } from '../../src/main/browser/wake-clock';
import { RefusalError } from '../../src/shared/refusal';
import { runHandler } from '../../src/main/agent/mcp-http/handler-helpers';
import type { CommandContext } from '../../src/main/agent/commands/types';
import {
  mcpCommandReporter,
  mcpRequestReporter,
  mcpToolReporter,
} from '../../src/main/agent/mcp-http/tool-reporting';
import {
  startMcpHttpServer,
  buildConfiguredMcpServer,
  buildAnswerMcpServer,
  buildWorkflowAgentMcpServer,
  type McpHttpServerHandle,
} from '../../src/main/agent/mcp-http-server';
import { RequestResolver } from '../../src/main/agent/mcp-http/project-resolver';
import type { BrowserToolDependencies } from '../../src/main/agent/mcp-http/browser-tools';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import { browserDriverReporter, withGuest, type DriverResult } from '../../src/main/browser/browser-pane-driver';
import { browserPaneRegistry } from '../../src/main/browser/browser-pane-registry';
import { popOutWindowManager } from '../../src/main/pop-out/pop-out-window-manager';
import { resetGuestDriveQueuesForTests } from '../../src/main/browser/guest-drive-queue';
import { setAgentInputSender, resetAgentInputSignalForTests } from '../../src/main/browser/agent-input-signal';
import type { ResolvedBrowserAutomationConfig } from '../../src/main/browser/browser-automation-config';

function reportedTags(): Record<string, string> {
  return reportHandledError.mock.calls[0]?.[1] as Record<string, string>;
}

beforeEach(() => {
  reportHandledError.mockClear();
  commandFault.error = null;
  buildFault.error = null;
  transportFault.error = null;
  queueFault.error = null;
  mcpCommandReporter.reset();
  mcpRequestReporter.reset();
  mcpToolReporter.reset();
  browserDriverReporter.reset();
});

describe('runHandler reports a throwing command handler', () => {
  const context = {} as CommandContext;

  it('sends one report tagged with the handler name, and still returns the message as a failure', async () => {
    commandFault.error = new TypeError('handler defect');

    const response = await runHandler('explode' as never, {}, context);

    expect(response).toEqual({ success: false, error: 'handler defect' });
    expect(reportHandledError).toHaveBeenCalledTimes(1);
    expect(reportedTags()).toMatchObject({ source: 'mcp_command', command: 'explode', error_name: 'TypeError' });
  });

  it('sends nothing for a refusal', async () => {
    commandFault.error = new RefusalError('not allowed here');

    const response = await runHandler('explode' as never, {}, context);

    expect(response.success).toBe(false);
    expect(reportHandledError).not.toHaveBeenCalled();
  });
});

function makeResolver(): RequestResolver {
  return new RequestResolver({
    ipcContext: { projectRepo: { list: () => [] } } as unknown as IpcContext,
    defaultContext: {} as unknown as CommandContext,
    defaultProjectId: 'proj-1',
    defaultProjectName: 'Test Project',
  });
}

/** Calls one tool on a built server through the SDK's own in-memory transport. */
async function callProbe(server: McpServer, toolName: string): Promise<{ isError?: boolean }> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'probe-client', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return (await client.callTool({ name: toolName, arguments: {} })) as { isError?: boolean };
  } finally {
    await client.close();
  }
}

// The three builders each wrap the server with withToolReporting. A tool's throw
// reaches the agent as an error result either way, so the report is the only
// thing that tells the two builds apart.
describe('every MCP server builder reports a throwing tool', () => {
  const resolver = makeResolver();

  it('the configured server', async () => {
    commandFault.error = new TypeError('tool defect');
    const server = buildConfiguredMcpServer(
      resolver,
      { tryReserve: () => true, limit: () => 1 },
      () => ({ enabled: false, allowInteraction: false, allowNavigation: false, allowEval: false, restrictNavigationToLocalhost: false }),
      null,
      { projectId: 'proj-1' } as BrowserToolDependencies,
    );

    const result = await callProbe(server, 'kangentic_probe_task');

    expect(result.isError).toBe(true);
    expect(reportHandledError).toHaveBeenCalledTimes(1);
    expect(reportedTags()).toMatchObject({ source: 'mcp_tool', tool: 'kangentic_probe_task' });
  });

  it('the answer server', async () => {
    commandFault.error = new TypeError('tool defect');
    const server = buildAnswerMcpServer(resolver, 'answer-caller');

    const result = await callProbe(server, 'kangentic_probe_search');

    expect(result.isError).toBe(true);
    expect(reportHandledError).toHaveBeenCalledTimes(1);
    expect(reportedTags()).toMatchObject({ source: 'mcp_tool', tool: 'kangentic_probe_search' });
  });

  it('the workflow agent server', async () => {
    commandFault.error = new TypeError('tool defect');
    const server = buildWorkflowAgentMcpServer(resolver, { tryReserve: () => true, limit: () => 1 }, 'workflow-1');

    const result = await callProbe(server, 'kangentic_probe_task');

    expect(result.isError).toBe(true);
    expect(reportHandledError).toHaveBeenCalledTimes(1);
    expect(reportedTags()).toMatchObject({ source: 'mcp_tool', tool: 'kangentic_probe_task' });
  });

  it('sends nothing for a refusal thrown by a tool', async () => {
    commandFault.error = new RefusalError('not allowed here');
    const server = buildAnswerMcpServer(resolver);

    const result = await callProbe(server, 'kangentic_probe_search');

    expect(result.isError).toBe(true);
    expect(reportHandledError).not.toHaveBeenCalled();
  });
});

describe('the HTTP server reports a failing request', () => {
  let handle: McpHttpServerHandle | undefined;

  afterEach(() => {
    handle?.close();
    handle = undefined;
  });

  async function postInitialize(): Promise<number> {
    const resolver = makeResolver();
    handle = await startMcpHttpServer(
      (projectId) => (projectId === 'proj-1' ? resolver : null),
      () => ({ enabled: false, allowInteraction: false, allowNavigation: false, allowEval: false, restrictNavigationToLocalhost: false }),
      { bindAddress: '127.0.0.1' },
    );
    const port = Number(new URL(handle.baseUrl).port);
    const token = handle.token;
    return new Promise<number>((resolve, reject) => {
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
          response.on('end', () => resolve(response.statusCode ?? 0));
        },
      );
      request.on('error', reject);
      request.end(JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1 }));
    });
  }

  it('tags a failure while building the per-request server as stage "request"', async () => {
    buildFault.error = new TypeError('builder defect');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(await postInitialize()).toBe(500);

    expect(reportHandledError).toHaveBeenCalledTimes(1);
    expect(reportedTags()).toMatchObject({ source: 'mcp_request', stage: 'request', error_name: 'TypeError' });
  });

  it('tags a failure inside the transport as stage "dispatch"', async () => {
    transportFault.error = new RangeError('transport defect');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(await postInitialize()).toBe(500);

    expect(reportHandledError).toHaveBeenCalledTimes(1);
    expect(reportedTags()).toMatchObject({ source: 'mcp_request', stage: 'dispatch', error_name: 'RangeError' });
  });

  it('sends nothing for a client that disconnected mid-dispatch', async () => {
    transportFault.error = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(await postInitialize()).toBe(500);

    expect(reportHandledError).not.toHaveBeenCalled();
  });
});

describe('withGuest reports a driver failure', () => {
  const config: ResolvedBrowserAutomationConfig = {
    enabled: true,
    allowInteraction: true,
    allowNavigation: true,
    allowEval: false,
    restrictNavigationToLocalhost: false,
  };
  const options = { selector: { projectId: 'p' }, capability: 'interact' as const, config };

  beforeEach(() => {
    vi.mocked(attachDebugger).mockReturnValue(true);
    vi.mocked(isDebuggerAttached).mockReturnValue(false);
    resetGuestDriveQueuesForTests();
    browserPaneRegistry.detachAll();
    browserPaneRegistry.register({ handle: 'pane_s', ownerSessionId: 's', taskId: 't', projectId: 'p', webContentsId: 7, url: null });
    vi.mocked(webContents.fromId).mockImplementation((requestedId: number) =>
      requestedId === 7 ? ({ id: 7, isDestroyed: () => false } as never) : (undefined as never),
    );
    resetAgentInputSignalForTests();
    setAgentInputSender(() => undefined);
  });

  afterEach(() => {
    resetAgentInputSignalForTests();
  });

  it('tags a throwing tool body kind "driver-error" with its capability', async () => {
    const result = await withGuest(options, async () => {
      throw new TypeError('body defect');
    });

    expect(result).toMatchObject({ ok: false, error: { kind: 'driver-error' } });
    expect(reportHandledError).toHaveBeenCalledTimes(1);
    expect(reportedTags()).toMatchObject({ source: 'browser_driver', capability: 'interact', kind: 'driver-error', error_name: 'TypeError' });
  });

  it('tags a failure to take the drive lock kind "acquire-error"', async () => {
    queueFault.error = new RangeError('queue defect');

    const result = await withGuest(options, async () => 'ran');

    expect(result).toMatchObject({ ok: false, error: { kind: 'driver-error' } });
    expect(reportHandledError).toHaveBeenCalledTimes(1);
    expect(reportedTags()).toMatchObject({ source: 'browser_driver', capability: 'interact', kind: 'acquire-error', error_name: 'RangeError' });
  });

  it('tags a debugger that would not attach kind "cdp-attach-failed"', async () => {
    vi.mocked(attachDebugger).mockReturnValue(false);

    const result = await withGuest(options, async () => 'ran');

    expect(result).toMatchObject({ ok: false, error: { kind: 'cdp-attach-failed' } });
    expect(reportHandledError).toHaveBeenCalledTimes(1);
    expect(reportedTags()).toMatchObject({
      source: 'browser_driver',
      capability: 'interact',
      kind: 'cdp-attach-failed',
      error_name: 'CdpAttachFailedError',
    });
  });

  describe('a screenshot that got no frame says what the capture found (DESKTOP-46)', () => {
    /**
     * A guest whose capture never gets a frame. Every other command answers with
     * nothing useful, which the capture path already tolerates, so the real
     * `captureScreenshotWithBudget` runs the whole way to the 5 s bound.
     */
    function uncompositedGuest(withHost: boolean, hostAnswers = true) {
      const sendCommand = (method: string): Promise<unknown> => (
        method === 'Page.captureScreenshot' ? new Promise(() => undefined) : Promise.resolve({ result: {} })
      );
      // A host whose compositor stopped never answers the hold's own calls.
      const hostCapturePage = hostAnswers ? async () => ({}) : () => new Promise(() => undefined);
      const host = { isDestroyed: () => false, capturePage: hostCapturePage };
      return {
        id: 7,
        isDestroyed: () => false,
        capturePage: async () => ({}),
        debugger: { sendCommand },
        ...(withHost ? { hostWebContents: host } : {}),
      };
    }

    async function captureUntilTimeout(): Promise<DriverResult<unknown>> {
      const pending = withGuest({ ...options, capability: 'observe' }, (guest) =>
        captureScreenshotWithBudget(guest, { surface: null }),
      );
      await vi.advanceTimersByTimeAsync(SCREENSHOT_TIMEOUT_MS);
      return pending;
    }

    beforeEach(() => {
      vi.useFakeTimers();
      resetWakeClockForTests();
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.mocked(BrowserWindow.fromWebContents).mockImplementation(() => null);
    });

    it('tags a parked pane whose hold armed behind a visible window, 12 s after an unlock', async () => {
      browserPaneRegistry.detachAll();
      browserPaneRegistry.register({
        handle: 'pane_s', ownerSessionId: 's', taskId: 't', projectId: 'p', webContentsId: 7, url: null, visibility: 'parked',
      });
      vi.mocked(webContents.fromId).mockReturnValue(uncompositedGuest(true) as never);
      vi.mocked(BrowserWindow.fromWebContents).mockReturnValue({ isMinimized: () => false, isVisible: () => true } as never);
      noteWake(Date.now() - 12_000);

      const result = await captureUntilTimeout();

      expect(result).toMatchObject({ ok: false, error: { kind: 'driver-error' } });
      expect(reportHandledError).toHaveBeenCalledTimes(1);
      expect(reportedTags()).toMatchObject({
        source: 'browser_driver',
        capability: 'observe',
        kind: 'driver-error',
        error_name: 'ScreenshotNotComposited',
        surface: 'parked',
        host_window: 'visible',
        hold: 'armed',
        host_hold: 'settled',
        guest_hold: 'settled',
        since_wake: 'under_30s',
      });
    });

    describe('names the display server Chromium draws to, from its own command line', () => {
      const realPlatform = process.platform;

      function setPlatform(platform: NodeJS.Platform): void {
        Object.defineProperty(process, 'platform', { value: platform, configurable: true });
      }

      async function timeOutParkedCapture(): Promise<void> {
        browserPaneRegistry.detachAll();
        browserPaneRegistry.register({
          handle: 'pane_s', ownerSessionId: 's', taskId: 't', projectId: 'p', webContentsId: 7, url: null, visibility: 'parked',
        });
        vi.mocked(webContents.fromId).mockReturnValue(uncompositedGuest(true) as never);
        vi.mocked(BrowserWindow.fromWebContents).mockReturnValue({ isMinimized: () => false, isVisible: () => true } as never);
        await captureUntilTimeout();
      }

      afterEach(() => {
        setPlatform(realPlatform);
        vi.mocked(app.commandLine.getSwitchValue).mockReset();
        vi.mocked(app.commandLine.getSwitchValue).mockReturnValue('');
      });

      // `auto` and `''` are what the switch reads when Chromium did not write back its choice.
      it.each([
        { switchValue: 'x11', expected: 'x11' },
        { switchValue: 'wayland', expected: 'wayland' },
        { switchValue: 'headless', expected: 'other' },
        { switchValue: 'auto', expected: 'other' },
        { switchValue: '', expected: 'other' },
      ])('tags --ozone-platform=$switchValue on Linux as $expected', async ({ switchValue, expected }) => {
        setPlatform('linux');
        vi.mocked(app.commandLine.getSwitchValue).mockReturnValue(switchValue);

        await timeOutParkedCapture();

        expect(reportHandledError).toHaveBeenCalledTimes(1);
        expect(reportedTags()).toMatchObject({ error_name: 'ScreenshotNotComposited', surface: 'parked', display_server: expected });
        expect(app.commandLine.getSwitchValue).toHaveBeenCalledWith('ozone-platform');
      });

      it('tags other off Linux, whatever the switch says', async () => {
        setPlatform('win32');
        vi.mocked(app.commandLine.getSwitchValue).mockReturnValue('wayland');

        await timeOutParkedCapture();

        expect(reportedTags()).toMatchObject({ error_name: 'ScreenshotNotComposited', display_server: 'other' });
      });
    });

    it('tags a hold whose host calls never returned, so a stopped compositor reads apart', async () => {
      browserPaneRegistry.detachAll();
      browserPaneRegistry.register({
        handle: 'pane_s', ownerSessionId: 's', taskId: 't', projectId: 'p', webContentsId: 7, url: null, visibility: 'showing',
      });
      vi.mocked(webContents.fromId).mockReturnValue(uncompositedGuest(true, false) as never);
      vi.mocked(BrowserWindow.fromWebContents).mockReturnValue({ isMinimized: () => false, isVisible: () => true } as never);

      await captureUntilTimeout();

      expect(reportHandledError).toHaveBeenCalledTimes(1);
      expect(reportedTags()).toMatchObject({
        error_name: 'ScreenshotNotComposited',
        host_window: 'visible',
        hold: 'armed',
        host_hold: 'none',
        guest_hold: 'settled',
      });
    });

    it('tags a lane, which has no host and takes no hold', async () => {
      browserPaneRegistry.detachAll();
      browserPaneRegistry.register({
        handle: 'lane_s', kind: 'lane', ownerSessionId: 's', taskId: 't', projectId: 'p', webContentsId: 7, url: null,
      });
      vi.mocked(webContents.fromId).mockReturnValue(uncompositedGuest(false) as never);

      await captureUntilTimeout();

      expect(reportHandledError).toHaveBeenCalledTimes(1);
      expect(reportedTags()).toMatchObject({
        error_name: 'ScreenshotNotComposited',
        surface: 'lane',
        host_window: 'none',
        hold: 'no_host',
        host_hold: 'none',
        guest_hold: 'none',
        since_wake: 'none',
      });
    });

    // Order matters: a lane wins, then an open pop-out (even for a parked pane), then the pane's own visibility.
    it.each([
      { label: 'parked pane with an open pop-out', visibility: 'parked', popOut: true, surface: 'popout' },
      { label: 'hidden pane', visibility: 'hidden', popOut: false, surface: 'hidden' },
      { label: 'showing pane', visibility: 'showing', popOut: false, surface: 'pane' },
    ] as const)('tags a $label as $surface', async ({ visibility, popOut, surface }) => {
      const hasSpy = vi.spyOn(popOutWindowManager, 'has').mockReturnValue(popOut);
      try {
        browserPaneRegistry.detachAll();
        browserPaneRegistry.register({
          handle: 'pane_v', ownerSessionId: 's', taskId: 't', projectId: 'p', webContentsId: 7, url: null, visibility,
        });
        vi.mocked(webContents.fromId).mockReturnValue(uncompositedGuest(false) as never);

        await captureUntilTimeout();

        expect(reportHandledError).toHaveBeenCalledTimes(1);
        expect(reportedTags()).toMatchObject({ error_name: 'ScreenshotNotComposited', surface });
        expect(hasSpy).toHaveBeenCalledWith('browser', { projectId: 'p', taskId: 't' });
      } finally {
        hasSpy.mockRestore();
      }
    });

    it('adds none of these tags to any other driver error', async () => {
      await withGuest(options, async () => {
        throw new TypeError('body defect');
      });

      const tags = reportedTags();
      for (const captureTag of ['surface', 'host_window', 'hold', 'host_hold', 'guest_hold', 'since_wake', 'display_server']) {
        expect(tags).not.toHaveProperty(captureTag);
      }
    });

    // The error's name is in the reported set, so it still reports. What the guard
    // decides is whether its fields may become tags. A hold settlement outside the
    // fixed set (page or user text) must never ride into a tag.
    const WELL_FORMED_TIMEOUT = { hold: 'armed', hostState: 'visible', hostHold: 'settled', guestHold: 'settled' };
    const WRONG_TIMEOUT_SHAPES: { label: string; fields: Record<string, unknown> }[] = [
      { label: 'a hostHold outside its set', fields: { ...WELL_FORMED_TIMEOUT, hostHold: 'bogus' } },
      { label: 'a guestHold outside its set', fields: { ...WELL_FORMED_TIMEOUT, guestHold: 'bogus' } },
      { label: 'no hostHold', fields: { ...WELL_FORMED_TIMEOUT, hostHold: undefined } },
      { label: 'no guestHold', fields: { ...WELL_FORMED_TIMEOUT, guestHold: undefined } },
      { label: 'a hostHold that is an inherited property name', fields: { ...WELL_FORMED_TIMEOUT, hostHold: 'toString' } },
      { label: 'a guestHold that is an inherited property name', fields: { ...WELL_FORMED_TIMEOUT, guestHold: 'constructor' } },
    ];

    it.each(WRONG_TIMEOUT_SHAPES)('adds none of the capture tags to a ScreenshotNotComposited with $label', async ({ fields }) => {
      const wrongShaped = Object.assign(new Error('no frame'), { name: 'ScreenshotNotComposited' }, fields);

      await withGuest(options, async () => {
        throw wrongShaped;
      });

      expect(reportHandledError).toHaveBeenCalledTimes(1);
      const tags = reportedTags();
      expect(tags).toMatchObject({ source: 'browser_driver', error_name: 'ScreenshotNotComposited' });
      for (const captureTag of ['surface', 'host_window', 'hold', 'host_hold', 'guest_hold', 'since_wake', 'display_server']) {
        expect(tags).not.toHaveProperty(captureTag);
      }
      expect(JSON.stringify(tags)).not.toContain('bogus');
      expect(JSON.stringify(tags)).not.toContain('toString');
      expect(JSON.stringify(tags)).not.toContain('constructor');
    });

    it('does tag a well-formed ScreenshotNotComposited built the same way, so the cases above fail for their fields', async () => {
      const wellFormed = Object.assign(new Error('no frame'), { name: 'ScreenshotNotComposited' }, WELL_FORMED_TIMEOUT);

      await withGuest(options, async () => {
        throw wellFormed;
      });

      expect(reportedTags()).toMatchObject({ hold: 'armed', host_hold: 'settled', guest_hold: 'settled' });
    });
  });

  describe('a capture refused as larger than its pane says what its request looked like (DESKTOP-48)', () => {
    const PANE = { widget: { width: 740, height: 749 }, widgetSource: 'reported', displayScale: 1 } as const;
    /** Larger than the pane on both axes. */
    const PAST_THE_PANE = { width: 1600, height: 1001 };
    /** A page 1280 wide and 3000 tall, which a full-page capture of this pane has to clip. */
    const TALL_PAGE = { width: 1280, height: 720, devicePixelRatio: 1, scrollX: 0, scrollY: 0, contentWidth: 1280, contentHeight: 3000 };
    const OVERRIDE = { width: 740, height: 463, deviceScaleFactor: 0 };

    /** The first 24 bytes of a PNG, which is all the size decoder reads. */
    function pngOfSize(size: { width: number; height: number }): string {
      const header = Buffer.alloc(24);
      header.writeUInt32BE(0x89504e47, 0);
      header.writeUInt32BE(size.width, 16);
      header.writeUInt32BE(size.height, 20);
      return header.toString('base64');
    }

    /**
     * A guest whose capture answers with an image past the pane. With a `page`
     * it describes itself, so the capture is planned. Without one every other
     * command answers with nothing useful and the capture goes out unplanned.
     */
    function oversizedGuest(page: object | null) {
      const sendCommand = (method: string): Promise<unknown> => {
        if (method === 'Page.captureScreenshot') return Promise.resolve({ data: pngOfSize(PAST_THE_PANE) });
        if (method === 'Runtime.evaluate' && page) return Promise.resolve({ result: { value: page } });
        return Promise.resolve({ result: {} });
      };
      return {
        id: 7,
        isDestroyed: () => false,
        capturePage: async () => ({}),
        getZoomFactor: () => 1,
        debugger: { sendCommand },
      };
    }

    function capture(captureOptions: Partial<Parameters<typeof captureScreenshotWithBudget>[1]> = {}): Promise<DriverResult<unknown>> {
      return withGuest({ ...options, capability: 'observe' }, (guest) =>
        captureScreenshotWithBudget(guest, { format: 'png', surface: PANE, ...captureOptions }),
      );
    }

    beforeEach(() => {
      vi.mocked(getDeviceMetrics).mockReset();
      vi.mocked(getDeviceMetrics).mockReturnValue(null);
      vi.mocked(isDebuggerAttached).mockReturnValue(true);
    });

    it('tags a clipped full page on a showing pane whose size the renderer reported', async () => {
      vi.mocked(webContents.fromId).mockReturnValue(oversizedGuest(TALL_PAGE) as never);

      const result = await capture({ fullPage: true });

      expect(result).toMatchObject({ ok: false, error: { kind: 'driver-error' } });
      expect(reportHandledError).toHaveBeenCalledTimes(1);
      expect(reportedTags()).toMatchObject({
        source: 'browser_driver',
        capability: 'observe',
        kind: 'driver-error',
        error_name: 'CaptureExceedsSurface',
        surface: 'pane',
        target: 'full_page',
        clipped: 'yes',
        emulated: 'no',
        widget_size: 'reported',
      });
      // The display server is a timeout's tag, not a refusal's.
      expect(reportedTags()).not.toHaveProperty('display_server');
    });

    it('tags a clip-free viewport under a viewport override', async () => {
      vi.mocked(webContents.fromId).mockReturnValue(oversizedGuest(null) as never);
      vi.mocked(getDeviceMetrics).mockReturnValue(OVERRIDE);

      await capture();

      expect(reportHandledError).toHaveBeenCalledTimes(1);
      expect(reportedTags()).toMatchObject({
        error_name: 'CaptureExceedsSurface',
        target: 'viewport',
        clipped: 'no',
        emulated: 'yes',
      });
    });

    it('tags a capture whose override could not be read, with no session attached to say', async () => {
      vi.mocked(webContents.fromId).mockReturnValue(oversizedGuest(null) as never);
      vi.mocked(isDebuggerAttached).mockReturnValue(false);

      await capture();

      expect(reportHandledError).toHaveBeenCalledTimes(1);
      expect(reportedTags()).toMatchObject({ target: 'viewport', clipped: 'no', emulated: 'unknown' });
    });

    it('tags a parked pane bounded by the host window, before its first size report', async () => {
      browserPaneRegistry.detachAll();
      browserPaneRegistry.register({
        handle: 'pane_s', ownerSessionId: 's', taskId: 't', projectId: 'p', webContentsId: 7, url: null, visibility: 'parked',
      });
      vi.mocked(webContents.fromId).mockReturnValue(oversizedGuest(TALL_PAGE) as never);

      await capture({ fullPage: true, surface: { ...PANE, widgetSource: 'fallback' } });

      expect(reportHandledError).toHaveBeenCalledTimes(1);
      expect(reportedTags()).toMatchObject({ surface: 'parked', widget_size: 'fallback' });
    });

    it('sends nothing for a capture nothing sized, and returns the image', async () => {
      // No clip and no override: Chromium returned the surface as it is, so the
      // recorded pane size was behind and the image is good.
      vi.mocked(webContents.fromId).mockReturnValue(oversizedGuest(null) as never);

      const result = await capture();

      expect(result).toMatchObject({ ok: true, data: PAST_THE_PANE });
      expect(reportHandledError).not.toHaveBeenCalled();
    });

    it('adds none of these tags to any other driver error', async () => {
      await withGuest(options, async () => {
        throw new TypeError('body defect');
      });

      const tags = reportedTags();
      for (const refusalTag of ['surface', 'target', 'clipped', 'emulated', 'widget_size']) {
        expect(tags).not.toHaveProperty(refusalTag);
      }
    });

    // The error's name is in the reported set, so it still reports. What the
    // guard decides is whether its fields may become tags. Each field is held
    // to its own values, so a string outside its enum (page or user text) can
    // never ride into a tag.
    const WELL_FORMED = { target: 'viewport', clipped: false, emulation: 'off', widgetSource: 'reported' };
    const WRONG_SHAPES: { label: string; fields: Record<string, unknown> }[] = [
      { label: 'no emulation', fields: { ...WELL_FORMED, emulation: undefined } },
      { label: 'clipped as a string', fields: { ...WELL_FORMED, clipped: 'no' } },
      { label: 'target as a number', fields: { ...WELL_FORMED, target: 3 } },
      { label: 'a target outside its enum', fields: { ...WELL_FORMED, target: 'https://example.test/checkout' } },
      { label: 'a widgetSource outside its enum', fields: { ...WELL_FORMED, widgetSource: 'user text' } },
      { label: 'an emulation outside its enum', fields: { ...WELL_FORMED, emulation: 'selector: #pay' } },
      { label: 'an inherited property name as a field value', fields: { ...WELL_FORMED, emulation: 'toString' } },
    ];

    it.each(WRONG_SHAPES)('adds none of the refusal tags to a CaptureExceedsSurface with $label', async ({ fields }) => {
      const wrongShaped = Object.assign(new Error('refused'), { name: 'CaptureExceedsSurface' }, fields);

      await withGuest(options, async () => {
        throw wrongShaped;
      });

      expect(reportHandledError).toHaveBeenCalledTimes(1);
      const tags = reportedTags();
      expect(tags).toMatchObject({ source: 'browser_driver', error_name: 'CaptureExceedsSurface' });
      for (const refusalTag of ['surface', 'target', 'clipped', 'emulated', 'widget_size']) {
        expect(tags).not.toHaveProperty(refusalTag);
      }
      expect(JSON.stringify(tags)).not.toContain('example.test');
      expect(JSON.stringify(tags)).not.toContain('user text');
    });

    it('does tag a well-formed CaptureExceedsSurface built the same way, so the cases above fail for their fields', async () => {
      const wellFormed = Object.assign(new Error('refused'), { name: 'CaptureExceedsSurface' }, WELL_FORMED);

      await withGuest(options, async () => {
        throw wellFormed;
      });

      expect(reportedTags()).toMatchObject({
        target: 'viewport',
        clipped: 'no',
        emulated: 'no',
        widget_size: 'reported',
      });
    });
  });

  it('sends nothing for an error the page or the agent caused', async () => {
    const result = await withGuest(options, async () => {
      throw new Error('selector matched nothing');
    });

    expect(result).toMatchObject({ ok: false, error: { kind: 'driver-error' } });
    expect(reportHandledError).not.toHaveBeenCalled();
  });
});
