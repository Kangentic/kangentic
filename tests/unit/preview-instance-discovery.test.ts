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

type ToolHandler = (input: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text?: string; data?: string; uri?: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}>;

let server: http.Server;
let answeringPort: number;
let closedPort: number;
let projectPath: string;
const bridgeRequests: string[] = [];
/** What the bridge answers, `{}` unless a test sets it. */
let bridgeBody = '{}';
/** The status the bridge answers with, 200 unless a test sets it. */
let bridgeStatus = 200;

/** The real tools, registered as the MCP server does, on the test's project. */
function registeredTools(captureCopyDirectory: string | null = null): Map<string, ToolHandler> {
  const tools = new Map<string, ToolHandler>();
  const mcpServer = {
    registerTool: (name: string, _config: unknown, handler: ToolHandler) => { tools.set(name, handler); },
  };
  const resolver = { defaultContextResolved: () => ({ context: { getProjectPath: () => projectPath } }) };
  registerDevtoolsPreviewTools(mcpServer as unknown as McpServer, resolver as unknown as RequestResolver, () => captureCopyDirectory);
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
    response.writeHead(request.url === '/info' ? 200 : bridgeStatus);
    response.end(bridgeBody);
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
  bridgeBody = '{}';
  bridgeStatus = 200;
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

describe('the event-loop-lag tool builds its journal query from `launch`', () => {
  it('sends launch, since and limit, and no until, when a launch is asked for', async () => {
    writeLockfile(projectPath);
    const eventLoopLag = registeredTools().get('kangentic_devtools_event_loop_lag');

    const result = await eventLoopLag?.({ launch: 'previous', since: '2026-11-24T00:00:00.000Z', limit: 50 });

    expect(result?.isError).toBeFalsy();
    const lagRequest = bridgeRequests.find((url) => url.startsWith('/event-loop-lag'));
    expect(lagRequest).toBeDefined();
    const query = new URL(lagRequest!, 'http://127.0.0.1').searchParams;
    expect(query.get('launch')).toBe('previous');
    expect(query.get('since')).toBe('2026-11-24T00:00:00.000Z');
    expect(query.get('limit')).toBe('50');
    expect(query.has('until')).toBe(false);
  });

  it('sends no query at all without a launch, even when since is given, so the live report answers', async () => {
    writeLockfile(projectPath);
    const eventLoopLag = registeredTools().get('kangentic_devtools_event_loop_lag');

    await eventLoopLag?.({ since: '2026-11-24T00:00:00.000Z' });

    expect(bridgeRequests).toContain('/event-loop-lag');
    expect(bridgeRequests.filter((url) => url.startsWith('/event-loop-lag?'))).toEqual([]);
  });
});

/**
 * Claude Code saves every image block under its config folder, and copying it
 * out of there stops on a permission prompt (task #1136). A devtools screenshot
 * is also written to the caller's own captures folder, and its metadata names
 * that copy.
 */
describe('a devtools screenshot names a copy in the caller\'s captures folder', () => {
  const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const shotFields = {
    format: 'png', byteLength: PNG_BYTES.byteLength, width: 2156, height: 29, viewportWidth: 2560, viewportHeight: 1392,
    deviceScaleFactor: 1, scale: 1, fullPage: false, elementClip: null, retries: 0,
  };

  it('keeps the inline image and writes the same bytes to the caller\'s folder', async () => {
    writeLockfile(projectPath);
    bridgeBody = JSON.stringify({ mode: 'inline', base64: PNG_BYTES.toString('base64'), ...shotFields });
    const copyFolder = path.join(projectPath, 'caller-captures');
    const screenshotElement = registeredTools(copyFolder).get('kangentic_devtools_screenshot_element');

    const result = await screenshotElement?.({ selector: '.tab-row' });

    expect(result?.content.find((block) => block.type === 'image')?.data).toBe(PNG_BYTES.toString('base64'));
    const meta = result?.structuredContent as { mode: string; filePath: string; location: string };
    expect(meta).toMatchObject({ mode: 'inline', location: 'local' });
    expect(path.dirname(meta.filePath)).toBe(copyFolder);
    expect(path.basename(meta.filePath)).toMatch(/^element-.*\.png$/);
    expect(fs.readFileSync(meta.filePath).equals(PNG_BYTES)).toBe(true);
  });

  it('copies a capture the bridge wrote under another checkout, and names the copy', async () => {
    writeLockfile(projectPath);
    const bridgeFile = path.join(projectPath, '.kangentic', 'devtools-shots', 'shot.png');
    fs.mkdirSync(path.dirname(bridgeFile), { recursive: true });
    fs.writeFileSync(bridgeFile, PNG_BYTES);
    bridgeBody = JSON.stringify({ mode: 'file', filePath: bridgeFile, fileUri: 'file:///unused', reason: 'over-inline-ceiling', ...shotFields });
    const copyFolder = path.join(projectPath, 'caller-captures');
    const screenshot = registeredTools(copyFolder).get('kangentic_devtools_screenshot');

    const result = await screenshot?.({});

    const meta = result?.structuredContent as { mode: string; filePath: string };
    expect(meta.mode).toBe('file');
    expect(path.dirname(meta.filePath)).toBe(copyFolder);
    expect(fs.readFileSync(meta.filePath).equals(PNG_BYTES)).toBe(true);
    expect(result?.content.find((block) => block.type === 'resource_link')?.uri).toMatch(/^file:.*screenshot-.*\.png$/);
  });

  it('names no file when the caller has no folder of its own', async () => {
    writeLockfile(projectPath);
    bridgeBody = JSON.stringify({ mode: 'inline', base64: PNG_BYTES.toString('base64'), ...shotFields });
    const screenshotElement = registeredTools(null).get('kangentic_devtools_screenshot_element');

    const result = await screenshotElement?.({ selector: '.tab-row' });

    expect(result?.content.find((block) => block.type === 'image')).toBeDefined();
    expect(result?.structuredContent).not.toHaveProperty('filePath');
  });

  it('still returns the image, with no filePath, when the copy cannot be written', async () => {
    writeLockfile(projectPath);
    bridgeBody = JSON.stringify({ mode: 'inline', base64: PNG_BYTES.toString('base64'), ...shotFields });
    const blockerFile = path.join(projectPath, 'not-a-directory');
    fs.writeFileSync(blockerFile, 'file');
    const screenshotElement = registeredTools(path.join(blockerFile, 'captures')).get('kangentic_devtools_screenshot_element');

    const result = await screenshotElement?.({ selector: '.tab-row' });

    expect(result?.isError).toBeFalsy();
    expect(result?.content.find((block) => block.type === 'image')?.data).toBe(PNG_BYTES.toString('base64'));
    expect(result?.structuredContent).not.toHaveProperty('filePath');
  });

  it('reports a bridge error as an error and never creates the copy folder', async () => {
    writeLockfile(projectPath);
    bridgeStatus = 500;
    bridgeBody = JSON.stringify({ error: { kind: 'capture-failed', detail: 'no frame' } });
    const copyFolder = path.join(projectPath, 'caller-captures');
    const screenshot = registeredTools(copyFolder).get('kangentic_devtools_screenshot');

    const result = await screenshot?.({});

    expect(result?.isError).toBe(true);
    expect(result?.content.find((block) => block.type === 'image')).toBeUndefined();
    expect(fs.existsSync(copyFolder)).toBe(false);
  });

  describe('a file-mode capture that gets no copy keeps its original path', () => {
    async function screenshotOf(originalPath: string, copyFolder: string) {
      writeLockfile(projectPath);
      bridgeBody = JSON.stringify({ mode: 'file', filePath: originalPath, fileUri: 'file:///original', reason: 'over-inline-ceiling', ...shotFields });
      return registeredTools(copyFolder).get('kangentic_devtools_screenshot')?.({});
    }

    it('when the file under devtools-shots is missing', async () => {
      const copyFolder = path.join(projectPath, 'caller-captures');
      const missing = path.join(projectPath, '.kangentic', 'devtools-shots', 'gone.png');

      const result = await screenshotOf(missing, copyFolder);

      expect(result?.isError).toBeFalsy();
      expect(result?.structuredContent).toMatchObject({ mode: 'file', filePath: missing });
      expect(fs.existsSync(copyFolder)).toBe(false);
    });

    it('when the real file is not under a devtools-shots folder', async () => {
      const copyFolder = path.join(projectPath, 'caller-captures');
      const elsewhere = path.join(projectPath, 'other-folder', 'shot.png');
      fs.mkdirSync(path.dirname(elsewhere), { recursive: true });
      fs.writeFileSync(elsewhere, PNG_BYTES);

      const result = await screenshotOf(elsewhere, copyFolder);

      expect(result?.isError).toBeFalsy();
      expect(result?.structuredContent).toMatchObject({ mode: 'file', filePath: elsewhere });
      expect(fs.existsSync(copyFolder)).toBe(false);
    });
  });
});
