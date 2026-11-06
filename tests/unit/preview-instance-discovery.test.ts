/**
 * A devtools call with no `instanceId` finds its preview from lockfiles, with
 * no git.
 *
 * It used to run the full worktree enumeration: every worktree of every
 * project, four or five git runs each, 9 to 47 s of `resolveMs` and stalls of up
 * to 4.6 s on main, so the probes recreated the freeze they were looking for.
 * A preview needs only its lockfile read and its `/info` answered, which is what
 * these drive: real lockfiles on disk and a real local server, with the
 * enumeration mocked so that any call to it fails the test.
 *
 * Tier: Unit.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

const { enumerateWorktrees } = vi.hoisted(() => ({ enumerateWorktrees: vi.fn(async () => []) }));

vi.mock('electron', () => ({ app: { getVersion: vi.fn(() => '1.0.0'), getPath: vi.fn(() => '/tmp') } }));
vi.mock('../../src/main/git/worktree-list', () => ({ enumerateWorktrees }));

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { findRespondingPreviews } from '../../src/devtools/main/instances';
import { registerDevtoolsPreviewTools } from '../../src/devtools/mcp/preview-tools';
import type { RequestResolver } from '../../src/main/agent/mcp-http/project-resolver';

/** Above any real pid on every platform CI runs. */
const DEAD_PID = 2 ** 30;

type ToolHandler = (input: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;

let server: http.Server;
let answeringPort: number;
let closedPort: number;
let projectPath: string;
const bridgeRequests: string[] = [];

/** The real tools, registered as the MCP server does, on the test's project. */
function registeredTools(): Map<string, ToolHandler> {
  const tools = new Map<string, ToolHandler>();
  const mcpServer = {
    registerTool: (name: string, _config: unknown, handler: ToolHandler) => { tools.set(name, handler); },
  };
  const resolver = { defaultContextResolved: () => ({ context: { getProjectPath: () => projectPath } }) };
  registerDevtoolsPreviewTools(mcpServer as unknown as McpServer, resolver as unknown as RequestResolver);
  return tools;
}

function writeLockfile(root: string, overrides: Record<string, unknown> = {}): void {
  fs.mkdirSync(path.join(root, '.kangentic'), { recursive: true });
  fs.writeFileSync(path.join(root, '.kangentic', 'preview.lock'), JSON.stringify({
    pid: process.pid,
    port: answeringPort,
    worktreePath: root,
    projectRoot: root,
    projectId: 'project-1',
    startedAt: '2026-11-05T00:00:00.000Z',
    kangenticVersion: '1.0.0',
    ...overrides,
  }));
}

function worktreePath(name: string): string {
  return path.join(projectPath, '.kangentic', 'worktrees', name);
}

function listen(target: http.Server): Promise<number> {
  return new Promise((resolve) => {
    target.listen(0, '127.0.0.1', () => resolve((target.address() as AddressInfo).port));
  });
}

beforeAll(async () => {
  server = http.createServer((request, response) => {
    bridgeRequests.push(request.url ?? '');
    response.writeHead(200);
    response.end('{}');
  });
  answeringPort = await listen(server);
  const closed = http.createServer();
  closedPort = await listen(closed);
  await new Promise((resolve) => closed.close(resolve));
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-preview-discovery-'));
  enumerateWorktrees.mockClear();
  bridgeRequests.length = 0;
});

afterEach(() => {
  fs.rmSync(projectPath, { recursive: true, force: true });
});

describe('findRespondingPreviews', () => {
  it('finds a preview in the project root', async () => {
    writeLockfile(projectPath);

    const found = await findRespondingPreviews(projectPath);

    expect(found.map((lockfile) => lockfile.projectRoot)).toEqual([projectPath]);
  });

  it('finds a preview in a task worktree, and both when both run', async () => {
    writeLockfile(projectPath);
    writeLockfile(worktreePath('task-a'));
    fs.mkdirSync(worktreePath('task-b'), { recursive: true });

    const found = await findRespondingPreviews(projectPath);

    expect(found.map((lockfile) => lockfile.projectRoot)).toEqual([projectPath, worktreePath('task-a')]);
  });

  it('leaves out a lockfile whose process died, and one whose port does not answer', async () => {
    writeLockfile(worktreePath('dead-pid'), { pid: DEAD_PID });
    writeLockfile(worktreePath('dead-port'), { port: closedPort });

    expect(await findRespondingPreviews(projectPath)).toEqual([]);
  });

  it('finds nothing in a project with no worktrees folder', async () => {
    expect(await findRespondingPreviews(projectPath)).toEqual([]);
  });

  it('never runs the worktree enumeration', async () => {
    writeLockfile(projectPath);
    writeLockfile(worktreePath('task-a'));

    await findRespondingPreviews(projectPath);

    expect(enumerateWorktrees).not.toHaveBeenCalled();
  });
});

describe('a devtools tool called with no instanceId', () => {
  it('reaches the project\'s one preview without the worktree enumeration', async () => {
    writeLockfile(worktreePath('task-a'));
    const terminalState = registeredTools().get('kangentic_devtools_terminal_state');

    const result = await terminalState?.({});

    expect(result?.isError).toBeFalsy();
    expect(bridgeRequests).toContain('/terminal-state');
    expect(enumerateWorktrees).not.toHaveBeenCalled();
  });

  it('refuses two previews and names the ids that pick one', async () => {
    writeLockfile(projectPath);
    writeLockfile(worktreePath('task-a'));
    const terminalState = registeredTools().get('kangentic_devtools_terminal_state');

    const result = await terminalState?.({});

    expect(result?.isError).toBe(true);
    expect(result?.content[0].text).toContain('multiple-instances');
    expect(result?.content[0].text).toContain('task-a');
    expect(bridgeRequests).not.toContain('/terminal-state');
  });
});
