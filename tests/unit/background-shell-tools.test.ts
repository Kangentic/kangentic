/**
 * kangentic_mark_background_service (task #857): the agent marks background
 * shells it started as services, so they stop holding its session. Pins the
 * handler's outcomes and recoverable errors, that it can only reach the
 * caller's own session, that the server offers it only to a connection naming
 * a task session, and that the name the hint uses is the name registered.
 */
import { describe, it, expect, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  registerBackgroundShellTools,
  type BackgroundShellToolDependencies,
} from '../../src/main/agent/mcp-http/background-shell-tools';
import { MUTATING_ANNOTATIONS } from '../../src/main/agent/mcp-http/annotations';
import { buildConfiguredMcpServer } from '../../src/main/agent/mcp-http-server';
import { urlNamesTaskSessionCaller } from '../../src/main/agent/mcp-http/caller-url';
import type { TaskCounter } from '../../src/main/agent/mcp-http/handler-helpers';
import type { RequestResolver } from '../../src/main/agent/mcp-http/project-resolver';
import type { BackgroundShellServiceOutcome } from '../../src/main/activity-engine/engine';
import { MARK_BACKGROUND_SERVICE_TOOL } from '../../src/shared/background-shell-hold';
import { MCP_TOOL_MANIFEST } from '../../src/shared/mcp-tool-manifest';

type ToolResult = { content: Array<{ text: string }>; isError?: boolean };
type ToolHandler = (args: { shellIds: string[] }) => Promise<ToolResult>;

function captureTool(dependencies: BackgroundShellToolDependencies): { handler: ToolHandler; name: string; annotations: unknown } {
  let captured: { handler: ToolHandler; name: string; annotations: unknown } | null = null;
  const server = {
    registerTool: (name: string, config: { annotations?: unknown }, handler: ToolHandler) => {
      captured = { handler, name, annotations: config.annotations };
    },
  };
  registerBackgroundShellTools(server as unknown as Parameters<typeof registerBackgroundShellTools>[0], dependencies);
  if (!captured) throw new Error('registerBackgroundShellTools registered nothing');
  return captured;
}

function makeMarker(outcomes: BackgroundShellServiceOutcome[] | null) {
  return { markBackgroundShellsAsServices: vi.fn(() => outcomes) };
}

describe('kangentic_mark_background_service', () => {
  it('registers under the name the launch hint uses, annotated mutating, and is listed in the manifest', () => {
    const { name, annotations } = captureTool({ sessions: makeMarker([]), callerSessionId: 'session-1' });
    expect(name).toBe(MARK_BACKGROUND_SERVICE_TOOL);
    expect(annotations).toBe(MUTATING_ANNOTATIONS);
    expect(MCP_TOOL_MANIFEST.some((entry) => entry.name === MARK_BACKGROUND_SERVICE_TOOL)).toBe(true);
  });

  it('marks the caller\'s own session\'s shells and reports each outcome', async () => {
    const sessions = makeMarker([
      { shellId: 'bserver01', outcome: 'marked' },
      { shellId: 'bflagged01', outcome: 'already-marked' },
      { shellId: 'bnotyet01', outcome: 'pending' },
    ]);
    const { handler } = captureTool({ sessions, callerSessionId: 'session-1' });
    const result = await handler({ shellIds: ['bserver01', 'bflagged01', 'bnotyet01', 'bserver01'] });
    expect(result.isError).toBeUndefined();
    // The URL's session, never a parameter, and each id once.
    expect(sessions.markBackgroundShellsAsServices).toHaveBeenCalledWith('session-1', ['bserver01', 'bflagged01', 'bnotyet01']);
    const lines = result.content[0].text.split('\n');
    expect(lines[0]).toMatch(/^bserver01: marked as a service/);
    expect(lines[1]).toMatch(/^bflagged01: already marked/);
    expect(lines[2]).toMatch(/^bnotyet01: Kangentic has not seen this shell start yet/);
  });

  it('refuses an id that is not shell-shaped, naming it, and changes nothing', async () => {
    const sessions = makeMarker([]);
    const { handler } = captureTool({ sessions, callerSessionId: 'session-1' });
    const result = await handler({ shellIds: ['bserver01', 'npm run dev'] });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('"npm run dev"');
    expect(sessions.markBackgroundShellsAsServices).not.toHaveBeenCalled();
  });

  it('refuses a connection that names no session, and a session Kangentic is not running', async () => {
    const noCaller = captureTool({ sessions: makeMarker([]) });
    expect((await noCaller.handler({ shellIds: ['bserver01'] })).isError).toBe(true);
    const gone = captureTool({ sessions: makeMarker(null), callerSessionId: 'session-gone' });
    const result = await gone.handler({ shellIds: ['bserver01'] });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('no running session');
  });
});

describe('buildConfiguredMcpServer offers the tool only with caller scope', () => {
  const resolver = {
    listProjects: () => [{ id: 'p1', name: 'Alpha', path: '/p1', lastOpened: '2026-01-01T00:00:00.000Z', isActive: true }],
    resolveProject: () => ({ error: 'unused in this test' }),
  } as unknown as RequestResolver;
  const taskCounter: TaskCounter = { tryReserve: () => true, limit: () => 100 };
  const browserOff = () => ({ enabled: false, allowInteraction: true, allowNavigation: true, allowEval: false, restrictNavigationToLocalhost: false });

  async function toolNames(backgroundShells: BackgroundShellToolDependencies | null): Promise<string[]> {
    const server = buildConfiguredMcpServer(resolver, taskCounter, browserOff, null, { projectId: 'p1' }, undefined, backgroundShells);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'guard', version: '1.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    await client.close();
    await server.close();
    return tools.map((tool) => tool.name);
  }

  it('registers it when the request carries caller scope, and not otherwise', async () => {
    expect(await toolNames({ sessions: makeMarker([]), callerSessionId: 'session-1' })).toContain(MARK_BACKGROUND_SERVICE_TOOL);
    expect(await toolNames(null)).not.toContain(MARK_BACKGROUND_SERVICE_TOOL);
  });
});

describe('urlNamesTaskSessionCaller', () => {
  it('is true only for a URL whose third segment names a task session', () => {
    expect(urlNamesTaskSessionCaller('http://127.0.0.1:54321/mcp/project-1/3f2a9c1e-session')).toBe(true);
    expect(urlNamesTaskSessionCaller('http://127.0.0.1:54321/mcp/project-1')).toBe(false);
    expect(urlNamesTaskSessionCaller('http://127.0.0.1:54321/mcp/project-1/workflow-wf1')).toBe(false);
    expect(urlNamesTaskSessionCaller('http://127.0.0.1:54321/mcp/project-1/answer-chat1')).toBe(false);
    expect(urlNamesTaskSessionCaller(undefined)).toBe(false);
    expect(urlNamesTaskSessionCaller('not a url')).toBe(false);
  });
});
