/**
 * The tools whose answer is about this computer, on a remote project. They return what they always did, and say so,
 * so an agent on a host does not read Kangentic's own logs or a pane's URL as its machine.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/main/agent/mcp-http/handler-helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/agent/mcp-http/handler-helpers')>();
  return { ...actual, callHandler: vi.fn(async () => ({ content: [{ type: 'text', text: '| id |\n| 1 |' }] })) };
});
// The tools also read the app's own config dir; point it at an empty folder so "nothing recorded" is deterministic.
const configDirHolder = vi.hoisted(() => ({ value: '' }));
vi.mock('../../src/main/config/paths', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/config/paths')>();
  return { ...actual, PATHS: { ...actual.PATHS, get configDir() { return configDirHolder.value || actual.PATHS.configDir; } } };
});
vi.mock('../../src/main/diagnostics/process-metrics', () => ({ getProcessMetrics: vi.fn(() => ({ processes: [] })) }));
vi.mock('../../src/main/git/worktree-list', () => ({ enumerateWorktrees: vi.fn(async () => []) }));

import { registerDiagnosticsTools } from '../../src/main/agent/mcp-http/diagnostics-tools';
import { registerSessionTools } from '../../src/main/agent/mcp-http/session-tools';
import type { RequestResolver } from '../../src/main/agent/mcp-http/project-resolver';
import { agentPathsForProject } from '../../src/main/remote/host-paths';
import { runSearchEverything } from '../../src/main/search/search-core';
import type { Project } from '../../src/shared/types';

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
}

function fakeServer() {
  const handlers = new Map<string, (args: Record<string, unknown>) => Promise<ToolResult>>();
  return {
    server: { registerTool: (name: string, _config: unknown, handler: (args: Record<string, unknown>) => Promise<ToolResult>) => handlers.set(name, handler) },
    call: (name: string, args: Record<string, unknown> = {}) => (handlers.get(name) as (input: Record<string, unknown>) => Promise<ToolResult>)(args),
  };
}

let scratch: string;

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-remote-labels-'));
  configDirHolder.value = path.join(scratch, 'config-dir');
});

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

function resolverFor(remote: Project['remote']): RequestResolver {
  const context = { projectId: 'p1', getProjectPath: () => scratch, agentPaths: () => agentPathsForProject({ path: scratch, remote }) };
  return { resolveProject: () => ({ context, projectId: 'p1', projectName: 'p', isDefault: true }) } as unknown as RequestResolver;
}

const REMOTE = { hostId: 'host-1', path: '/home/dev/proj' };

describe('Kangentic\'s own diagnostics', () => {
  it('say they are from the user\'s computer on a remote project', async () => {
    const { server, call } = fakeServer();
    registerDiagnosticsTools(server as never, resolverFor(REMOTE));

    for (const tool of ['kangentic_tail_logs', 'kangentic_get_ipc_log', 'kangentic_get_recent_crashes']) {
      const result = await call(tool);
      expect(result.content[0].text).toContain('From Kangentic on the user\'s computer');
    }
  });

  it('carry location: local in their structured answer', async () => {
    const { server, call } = fakeServer();
    registerDiagnosticsTools(server as never, resolverFor(REMOTE));

    expect((await call('kangentic_tail_logs')).structuredContent).toMatchObject({ location: 'local' });
    expect((await call('kangentic_get_ipc_log')).structuredContent).toMatchObject({ location: 'local' });
    expect((await call('kangentic_get_process_metrics')).structuredContent).toMatchObject({ location: 'local' });
  });

  it('add nothing to their text on a project on this computer', async () => {
    const { server, call } = fakeServer();
    registerDiagnosticsTools(server as never, resolverFor(null));

    expect((await call('kangentic_tail_logs')).content[0].text).not.toContain('From Kangentic');
  });

  const NOTE = '[From Kangentic on the user\'s computer, not your host]';
  const TOOLS = ['kangentic_tail_logs', 'kangentic_get_recent_crashes', 'kangentic_get_ipc_log'];

  it('carry the note and location: local even when nothing is recorded (no crashes, no logs, no IPC)', async () => {
    const { server, call } = fakeServer();
    registerDiagnosticsTools(server as never, resolverFor(REMOTE));

    for (const tool of TOOLS) {
      const result = await call(tool);
      expect(result.content[0].text.startsWith(NOTE), tool).toBe(true);
      expect(result.structuredContent, tool).toMatchObject({ items: [], location: 'local' });
    }
    expect((await call('kangentic_get_recent_crashes')).content[0].text).toContain('No crashes recorded');
  });

  it('carry the note and location: local when there are records', async () => {
    const day = '2026-01-02';
    const logs = path.join(scratch, '.kangentic', 'logs');
    fs.mkdirSync(path.join(logs, 'crashes'), { recursive: true });
    fs.writeFileSync(path.join(logs, `${day}.log`), `${JSON.stringify({ ts: `${day}T00:00:00Z`, level: 'error', source: 'main', args: ['boom'] })}\n`);
    fs.writeFileSync(path.join(logs, `ipc-${day}.jsonl`), `${JSON.stringify({ ts: `${day}T00:00:00Z`, channel: 'task:list' })}\n`);
    fs.writeFileSync(path.join(logs, 'crashes', `${day}.json`), JSON.stringify({ ts: `${day}T00:00:00Z`, kind: 'main-uncaught-exception' }));
    const { server, call } = fakeServer();
    registerDiagnosticsTools(server as never, resolverFor(REMOTE));

    for (const [tool, args] of [['kangentic_tail_logs', { date: day }], ['kangentic_get_recent_crashes', {}], ['kangentic_get_ipc_log', { date: day }]] as const) {
      const result = await call(tool, args);
      expect(result.content[0].text.startsWith(NOTE), tool).toBe(true);
      expect(result.structuredContent, tool).toMatchObject({ location: 'local' });
      expect((result.structuredContent as { items: unknown[] }).items, tool).toHaveLength(1);
    }
  });

  it('put no note in the text of a local project, empty or not', async () => {
    const { server, call } = fakeServer();
    registerDiagnosticsTools(server as never, resolverFor(null));

    for (const tool of TOOLS) {
      const result = await call(tool);
      expect(result.content[0].text, tool).not.toContain('From Kangentic');
      expect(result.structuredContent, tool).toMatchObject({ location: 'local' });
    }
    expect((await call('kangentic_get_recent_crashes')).content[0].text).toBe('No crashes recorded.');
  });
});

describe('kangentic_query_db', () => {
  it('says what its path columns hold on a remote project, and leaves the rows as stored', async () => {
    const { server, call } = fakeServer();
    registerSessionTools(server as never, resolverFor(REMOTE), null);

    const result = await call('kangentic_query_db', { sql: 'SELECT 1' });

    expect(result.content[0].text).toContain('| id |');
    expect(result.content[0].text).toContain(`${scratch} is /home/dev/proj on the host`);
  });

  it('adds nothing on a project on this computer', async () => {
    const { server, call } = fakeServer();
    registerSessionTools(server as never, resolverFor(null), null);

    const result = await call('kangentic_query_db', { sql: 'SELECT 1' });

    expect(result.content[0].text).toBe('| id |\n| 1 |');
  });
});

describe('a search hit for a project', () => {
  const project = (remote: Project['remote'], projectPath: string): Project => ({ id: 'p1', name: 'alpha', path: projectPath, remote } as Project);

  it('finds and shows a remote project by its path on the host, never the stand-in', async () => {
    const standIn = path.join(scratch, 'remote-projects', 'p1');

    const search = (query: string) => runSearchEverything({ query, projects: [], includeProjectHits: true, projectsForProjectHits: [project(REMOTE, standIn)] });

    const byHostPath = await search('/home/dev/proj');
    const byStandIn = await search('remote-projects');

    expect(byHostPath.filter((hit) => hit.kind === 'project')).toMatchObject([{ projectPath: '/home/dev/proj', location: 'host' }]);
    expect(byStandIn.filter((hit) => hit.kind === 'project')).toEqual([]);
  });
});
