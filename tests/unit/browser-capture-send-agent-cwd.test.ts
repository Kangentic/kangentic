/**
 * The @-path a Browser pane Send hands the agent (`BROWSER_CAPTURE_SEND` in
 * src/main/ipc/handlers/browser.ts).
 *
 * The capture PNG is written under the project root's session folder, and the
 * path in the prompt is relative to the folder the agent works in. The pane
 * computes that folder from the board's task row, which can be stale (a row
 * with no worktree path yet gives the project root while the agent already runs
 * in the worktree). Main's own record of the session's command folder wins, and
 * the pane's value is only the fallback for a session main does not know.
 *
 * Runs the real registered handler over real folders under os.tmpdir(). Only
 * Electron, the pane registry and the lane hand-off are stubbed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { capturedHandlers } = vi.hoisted(() => ({
  capturedHandlers: new Map<string, (...args: unknown[]) => unknown>(),
}));

vi.mock('electron', () => ({
  app: { getVersion: vi.fn(() => '0.0.0'), getPath: vi.fn(() => os.tmpdir()) },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      capturedHandlers.set(channel, handler);
    }),
    on: vi.fn(),
  },
  session: { fromPartition: vi.fn() },
  Notification: { isSupported: vi.fn(() => false) },
  dialog: { showOpenDialog: vi.fn() },
  shell: { openPath: vi.fn(), openExternal: vi.fn() },
}));

vi.mock('../../src/main/browser/browser-lane-handoff', () => ({
  installLaneHandoff: vi.fn(),
}));

vi.mock('../../src/main/browser/browser-pane-registry', () => ({
  browserPaneRegistry: {
    register: vi.fn(),
    unregister: vi.fn(),
    unregisterByWebContentsId: vi.fn(),
    setVisibility: vi.fn(),
    setPaneClosedHandler: vi.fn(),
    setPaneRegisteredHandler: vi.fn(),
    getByTaskId: vi.fn(() => []),
    resolveLiveGuest: vi.fn(),
    list: vi.fn(() => []),
  },
}));

import { registerBrowserHandlers } from '../../src/main/ipc/handlers/browser';
import { IPC } from '../../src/shared/ipc-channels';
import type { BrowserCaptureInput } from '../../src/shared/types';

const SESSION_ID = '3f2b8c1e-5d4a-4e9b-8a7c-1d2e3f4a5b6c';
// A 1x1 transparent PNG, base64.
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

let rootDir: string;
let projectRoot: string;
let worktreeDir: string;
let getSessionCommandCwd: ReturnType<typeof vi.fn>;
let submitContent: ReturnType<typeof vi.fn>;

function makeInput(cwd: string): BrowserCaptureInput {
  return {
    sessionId: SESSION_ID,
    taskId: 'task-capture',
    cwd,
    url: 'http://localhost:5173/',
    pngBase64: PNG_BASE64,
    pickedElement: null,
    selectedText: '',
    note: 'check this',
  };
}

async function sendCapture(input: BrowserCaptureInput): Promise<{ filePath: string }> {
  const handler = capturedHandlers.get(IPC.BROWSER_CAPTURE_SEND);
  if (!handler) throw new Error('BROWSER_CAPTURE_SEND handler not registered');
  return (await handler(undefined, input)) as { filePath: string };
}

/** The @-path in the payload handed to the terminal submit. */
function submittedAtPath(): string {
  expect(submitContent).toHaveBeenCalledTimes(1);
  const payload = submitContent.mock.calls[0][1] as string;
  const match = /Screenshot: @(\S+)/.exec(payload);
  if (!match) throw new Error(`no @-path in payload: ${payload}`);
  return match[1];
}

beforeEach(() => {
  capturedHandlers.clear();
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-capture-cwd-'));
  projectRoot = path.join(rootDir, 'project');
  worktreeDir = path.join(projectRoot, '.kangentic', 'worktrees', 'task-1');
  fs.mkdirSync(worktreeDir, { recursive: true });

  getSessionCommandCwd = vi.fn(() => undefined);
  submitContent = vi.fn(async () => undefined);
  const context = {
    currentProjectPath: projectRoot,
    currentProjectId: 'project-1',
    configManager: { loadProjectOverrides: vi.fn(() => null) },
    sessionManager: {
      getSessionCommandCwd,
      getSessionAgentName: vi.fn(() => undefined),
      getSessionProjectId: vi.fn(() => undefined),
      hasLiveSessionForTask: vi.fn(() => false),
      on: vi.fn(),
    },
    terminalSubmit: { submitContent },
  };
  registerBrowserHandlers(context as unknown as Parameters<typeof registerBrowserHandlers>[0]);
});

afterEach(() => {
  fs.rmSync(rootDir, { recursive: true, force: true });
});

describe('BROWSER_CAPTURE_SEND agent cwd', () => {
  it("anchors the @-path at the session's worktree when the pane sent the project root", async () => {
    getSessionCommandCwd.mockReturnValue(worktreeDir);

    const { filePath } = await sendCapture(makeInput(projectRoot));

    expect(getSessionCommandCwd).toHaveBeenCalledWith(SESSION_ID);
    expect(fs.existsSync(filePath)).toBe(true);
    const expected = path.relative(worktreeDir, filePath).replace(/\\/g, '/');
    // The worktree sits under the project root, so a path from the root would
    // not start with `..`. Main's record makes it walk up out of the worktree.
    expect(expected.startsWith('..')).toBe(true);
    expect(submittedAtPath()).toBe(expected);
  });

  it("falls back to the pane's cwd for a session main does not know", async () => {
    getSessionCommandCwd.mockReturnValue(undefined);

    const { filePath } = await sendCapture(makeInput(projectRoot));

    const expected = path.relative(projectRoot, filePath).replace(/\\/g, '/');
    expect(expected.startsWith('..')).toBe(false);
    expect(submittedAtPath()).toBe(expected);
  });
});
