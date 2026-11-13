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
 * wrap, and the browser driver's three reports.
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
  app: { getPath: () => '/tmp', isPackaged: false },
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
  dismissedBeforeunloadSince: vi.fn(() => false),
  getDialogResponse: vi.fn(),
}));

import { webContents } from 'electron';
import { attachDebugger, isDebuggerAttached } from '../../src/main/browser/cdp/cdp';
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
import { browserDriverReporter, withGuest } from '../../src/main/browser/browser-pane-driver';
import { browserPaneRegistry } from '../../src/main/browser/browser-pane-registry';
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

  it('sends nothing for an error the page or the agent caused', async () => {
    const result = await withGuest(options, async () => {
      throw new Error('selector matched nothing');
    });

    expect(result).toMatchObject({ ok: false, error: { kind: 'driver-error' } });
    expect(reportHandledError).not.toHaveBeenCalled();
  });
});
