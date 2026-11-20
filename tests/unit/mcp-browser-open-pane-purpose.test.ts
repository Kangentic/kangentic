/**
 * `kangentic_browser_open_pane` refuses a call that does not say why it opens
 * the pane (decision 46, option 2C).
 *
 * The refusal comes from the tool's own input schema: the MCP SDK turns a
 * failed parse into a tool error that carries the schema's messages. This runs
 * a real MCP client against the real server over an in-memory transport, so it
 * pins the text the AGENT actually receives, not the schema's internals: a
 * refactor that dropped the custom messages (or the SDK starting to swallow
 * them) would leave the agent with a bare "Required" and no idea what to send.
 *
 * The opener is a spy, so "nothing was opened" is checked directly.
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
vi.mock('../../src/main/browser/browser-pane-opener', () => ({
  openPaneForCallerTask: vi.fn(async () => ({ ok: false, error: { kind: 'stubbed', detail: 'stubbed' } })),
  closePanes: vi.fn(),
}));

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildConfiguredMcpServer } from '../../src/main/agent/mcp-http-server';
import { openPaneForCallerTask } from '../../src/main/browser/browser-pane-opener';
import type { TaskCounter } from '../../src/main/agent/mcp-http/handler-helpers';
import type { RequestResolver } from '../../src/main/agent/mcp-http/project-resolver';
import type { ResolvedBrowserAutomationConfig } from '../../src/main/browser/browser-automation-config';

const PROJECT = 'p1';

function makeResolver(): RequestResolver {
  return {
    listProjects: () => [
      { id: PROJECT, name: 'Alpha', path: '/p1', lastOpened: '2026-01-01T00:00:00.000Z', isActive: true },
    ],
    resolveProject: () => ({ error: 'unused in this test' }),
  } as unknown as RequestResolver;
}

const taskCounter: TaskCounter = { tryReserve: () => true, limit: () => 100 };

function automationConfig(): ResolvedBrowserAutomationConfig {
  return {
    enabled: true,
    allowInteraction: true,
    allowNavigation: true,
    allowEval: false,
    restrictNavigationToLocalhost: false,
  };
}

async function callOpenPane(args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
  const server = buildConfiguredMcpServer(makeResolver(), taskCounter, automationConfig, null, { projectId: PROJECT });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'open-pane-purpose', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({ name: 'kangentic_browser_open_pane', arguments: args });
    const content = result.content as { type: string; text?: string }[];
    return { isError: result.isError === true, text: content.map((part) => part.text ?? '').join('\n') };
  } finally {
    await client.close();
    await server.close();
  }
}

describe('kangentic_browser_open_pane says why or opens nothing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('refuses a call with no purpose and no reason, naming both and what to send', async () => {
    const result = await callOpenPane({ url: 'http://localhost:5173' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('purpose "for-user"');
    expect(result.text).toContain('"own-work"');
    expect(result.text).toContain('Pass reason');
    expect(result.text).toContain('Nothing was opened.');
    expect(openPaneForCallerTask).not.toHaveBeenCalled();
  });

  it('refuses a purpose that is not one of the two', async () => {
    const result = await callOpenPane({ url: 'http://localhost:5173', purpose: 'debugging', reason: 'checking the app' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('purpose "for-user"');
    expect(openPaneForCallerTask).not.toHaveBeenCalled();
  });

  it('refuses an empty reason and one past the length limit', async () => {
    const empty = await callOpenPane({ purpose: 'own-work', reason: '   ' });
    expect(empty.isError).toBe(true);
    expect(empty.text).toContain('Pass reason');

    const long = await callOpenPane({ purpose: 'own-work', reason: 'x'.repeat(81) });
    expect(long.isError).toBe(true);
    expect(long.text).toContain('up to 80 characters');
    expect(openPaneForCallerTask).not.toHaveBeenCalled();
  });

  it('hands a complete call to the opener with its purpose and reason', async () => {
    await callOpenPane({ url: 'http://localhost:5173', purpose: 'own-work', reason: 'measuring canvas board heights' });
    expect(openPaneForCallerTask).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: 'own-work', reason: 'measuring canvas board heights', url: 'http://localhost:5173' }),
    );
  });
});
