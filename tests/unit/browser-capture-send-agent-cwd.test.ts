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
import { saveAnnotationCapture } from '../../src/main/browser/annotation-drafts';
import type { BrowserCaptureInput, BrowserPickedElement } from '../../src/shared/types';

const SESSION_ID = '3f2b8c1e-5d4a-4e9b-8a7c-1d2e3f4a5b6c';
// A 1x1 transparent PNG, base64.
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

let rootDir: string;
let projectRoot: string;
let worktreeDir: string;
let otherProjectRoot: string;
let getSessionCommandCwd: ReturnType<typeof vi.fn>;
let submitContent: ReturnType<typeof vi.fn>;

function makeInput(cwd: string): BrowserCaptureInput {
  return {
    sessionId: SESSION_ID,
    taskId: 'task-capture',
    cwd,
    url: 'http://localhost:5173/',
    pngBase64: PNG_BASE64,
    annotations: [],
    viewport: null,
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
  otherProjectRoot = path.join(rootDir, 'other-project');
  worktreeDir = path.join(projectRoot, '.kangentic', 'worktrees', 'task-1');
  fs.mkdirSync(worktreeDir, { recursive: true });
  fs.mkdirSync(otherProjectRoot, { recursive: true });

  getSessionCommandCwd = vi.fn(() => undefined);
  submitContent = vi.fn(async () => undefined);
  const context = {
    currentProjectPath: projectRoot,
    currentProjectId: 'project-1',
    configManager: { loadProjectOverrides: vi.fn(() => null) },
    projectRepo: { getById: vi.fn((id: string) => (id === 'project-2' ? { path: otherProjectRoot } : undefined)) },
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

describe('BROWSER_CAPTURE_SEND with annotations', () => {
  it('copies the capture of an annotation out of view next to the screenshot and names it', async () => {
    getSessionCommandCwd.mockReturnValue(undefined);
    const captureId = await saveAnnotationCapture(projectRoot, 'task-capture', PNG_BASE64);
    const element: BrowserPickedElement = {
      selector: 'button.save',
      tagName: 'BUTTON',
      classes: ['save'],
      role: 'button',
      accessibleName: 'Save',
      rect: { x: 0, y: 900, width: 80, height: 30 },
      computedStyles: {},
      outerHTML: '<button class="save">Save</button>',
      ancestors: [],
    };

    const { filePath } = await sendCapture({
      ...makeInput(projectRoot),
      annotations: [
        { number: 1, note: 'Move this up', url: 'http://localhost:5173/', onPage: true, inViewport: false, items: [{ id: 'item', kind: 'element', element }], captureId },
      ],
      viewport: { width: 1280, height: 720, scrollX: 0, scrollY: 0 },
    });

    const payload = submitContent.mock.calls[0][1] as string;
    const captureLine = /Annotation 1, captured before the page scrolled: @(\S+)/.exec(payload);
    if (!captureLine) throw new Error(`no capture line in payload: ${payload}`);
    const copied = path.resolve(projectRoot, captureLine[1]);
    expect(path.dirname(copied)).toBe(path.dirname(filePath));
    expect(fs.existsSync(copied)).toBe(true);
    expect(payload).toContain('<note>Move this up</note>');
  });
});

function pickedElement(overrides: Partial<BrowserPickedElement> = {}): BrowserPickedElement {
  return {
    selector: 'div.card',
    tagName: 'DIV',
    classes: ['card'],
    role: null,
    accessibleName: '',
    rect: { x: 0, y: 0, width: 80, height: 30 },
    computedStyles: { color: 'rgb(1, 2, 3)' },
    outerHTML: '<div class="card"><span>inner</span></div>',
    ancestors: [],
    ...overrides,
  } as BrowserPickedElement;
}

function annotationInput(overrides: Record<string, unknown> = {}): BrowserCaptureInput['annotations'][number] {
  return {
    number: 1,
    note: 'note',
    url: 'http://localhost:5173/',
    onPage: true,
    inViewport: true,
    items: [{ id: 'item', kind: 'element', element: pickedElement() }],
    captureId: null,
    ...overrides,
  } as BrowserCaptureInput['annotations'][number];
}

function submittedPayload(): string {
  expect(submitContent).toHaveBeenCalledTimes(1);
  return submitContent.mock.calls[0][1] as string;
}

describe('BROWSER_CAPTURE_SEND annotation files', () => {
  it('moves a long element detail to annotations-<stamp>.xml and names it in the prompt', async () => {
    const hugeHtml = `<div class="card">${'<span>filler</span>'.repeat(500)}</div>`;
    const { filePath } = await sendCapture({
      ...makeInput(projectRoot),
      annotations: [annotationInput({ items: [{ id: 'item', kind: 'element', element: pickedElement({ outerHTML: hugeHtml }) }] })],
      viewport: { width: 1280, height: 720, scrollX: 0, scrollY: 0 },
    });

    const payload = submittedPayload();
    const reference = /Full styles and HTML for every element: (\S+)/.exec(payload);
    if (!reference) throw new Error(`no details reference in payload: ${payload}`);
    // The prompt path is relative to the agent's cwd (the project root here).
    const detailsFile = path.resolve(projectRoot, reference[1]);
    expect(path.dirname(detailsFile)).toBe(path.dirname(filePath));
    expect(path.basename(detailsFile)).toMatch(/^annotations-\d+\.xml$/);
    expect(fs.readFileSync(detailsFile, 'utf-8')).toContain('<outer_html>');
    // The inline prompt no longer carries the HTML itself.
    expect(payload).not.toContain('<outer_html>');
  });

  it('writes no details file when the paste fits inline', async () => {
    const { filePath } = await sendCapture({
      ...makeInput(projectRoot),
      annotations: [annotationInput()],
    });
    const leftovers = fs.readdirSync(path.dirname(filePath)).filter((name) => name.endsWith('.xml'));
    expect(leftovers).toEqual([]);
  });

  it("puts the screenshot under the project named by projectId, not the open one", async () => {
    const { filePath } = await sendCapture({ ...makeInput(projectRoot), projectId: 'project-2' });
    const expectedRoot = path.join(otherProjectRoot, '.kangentic', 'sessions', SESSION_ID);
    expect(path.relative(expectedRoot, filePath).startsWith('..')).toBe(false);
    expect(fs.existsSync(path.join(projectRoot, '.kangentic', 'sessions'))).toBe(false);
  });

  it('copies a capture shared by two annotations once and names it once', async () => {
    const captureId = await saveAnnotationCapture(projectRoot, 'task-capture', PNG_BASE64);
    const { filePath } = await sendCapture({
      ...makeInput(projectRoot),
      annotations: [
        annotationInput({ number: 1, inViewport: false, captureId }),
        annotationInput({ number: 2, inViewport: false, captureId }),
      ],
    });
    const copies = fs.readdirSync(path.dirname(filePath)).filter((name) => name.startsWith('annotation-') && name.endsWith('.png'));
    expect(copies).toHaveLength(1);
    const payload = submittedPayload();
    expect(payload.match(/@\S*annotation-\d+-\d+\.png/g)).toHaveLength(1);
    expect(payload).toContain('Annotations 1, 2, captured before the page scrolled');
  });

  it('still sends when an annotation capture file is missing, and names no missing file', async () => {
    const { filePath } = await sendCapture({
      ...makeInput(projectRoot),
      annotations: [annotationInput({ inViewport: false, captureId: '0123456789abcdef' })],
    });
    const payload = submittedPayload();
    expect(payload).toContain('<note>note</note>');
    expect(payload).not.toContain('captured before the page scrolled');
    expect(payload).not.toMatch(/annotation-\d+-\d+\.png/);
    const copies = fs.readdirSync(path.dirname(filePath)).filter((name) => name.startsWith('annotation-'));
    expect(copies).toEqual([]);
  });

  it('drops an annotation whose number could leave the captures folder', async () => {
    const captureId = await saveAnnotationCapture(projectRoot, 'task-capture', PNG_BASE64);
    await sendCapture({
      ...makeInput(projectRoot),
      annotations: [annotationInput({ number: '../../x', note: 'evil note', inViewport: false, captureId })] as unknown as BrowserCaptureInput['annotations'],
    });
    const payload = submittedPayload();
    expect(payload).not.toContain('../../x');
    expect(payload).not.toContain('evil note');
    const sessionFolder = path.join(projectRoot, '.kangentic', 'sessions', SESSION_ID);
    expect(fs.readdirSync(sessionFolder)).toEqual(['captures']);
    const captureFiles = fs.readdirSync(path.join(sessionFolder, 'captures'));
    expect(captureFiles.filter((name) => name.startsWith('annotation-'))).toEqual([]);
  });
});

describe('annotation draft handlers', () => {
  function handlerFor(channel: string): (...args: unknown[]) => unknown {
    const handler = capturedHandlers.get(channel);
    if (!handler) throw new Error(`${channel} handler not registered`);
    return handler;
  }

  function registerWithNoProject(): void {
    capturedHandlers.clear();
    registerBrowserHandlers({
      currentProjectPath: null,
      currentProjectId: null,
      projectRepo: { getById: vi.fn(() => undefined) },
      configManager: { loadProjectOverrides: vi.fn(() => null) },
      sessionManager: { on: vi.fn() },
      terminalSubmit: { submitContent },
    } as unknown as Parameters<typeof registerBrowserHandlers>[0]);
  }

  it('load and discard with no project open resolve to nothing', async () => {
    registerWithNoProject();
    expect(await handlerFor(IPC.BROWSER_ANNOTATIONS_LOAD)(undefined, 'task-1')).toBeNull();
    expect(await handlerFor(IPC.BROWSER_ANNOTATIONS_DISCARD)(undefined, 'task-1')).toBeUndefined();
  });

  it('save and save-capture with no project open reject with No project open', async () => {
    registerWithNoProject();
    // ipcMain turns a synchronous throw into a rejection, so wrap the call the same way.
    const save = handlerFor(IPC.BROWSER_ANNOTATIONS_SAVE);
    const saveCapture = handlerFor(IPC.BROWSER_ANNOTATIONS_SAVE_CAPTURE);
    await expect((async () => save(undefined, 'task-1', {}))()).rejects.toThrow('No project open');
    await expect((async () => saveCapture(undefined, 'task-1', PNG_BASE64))()).rejects.toThrow('No project open');
  });

  it('round-trips a draft through the open project', async () => {
    const draft = {
      version: 1,
      activeId: null,
      annotations: [{ id: 'a0', note: 'n', url: 'http://localhost:5173/', items: [], captureId: null }],
    };
    await handlerFor(IPC.BROWSER_ANNOTATIONS_SAVE)(undefined, 'task-1', draft);
    expect(await handlerFor(IPC.BROWSER_ANNOTATIONS_LOAD)(undefined, 'task-1')).toEqual(draft);
    await handlerFor(IPC.BROWSER_ANNOTATIONS_DISCARD)(undefined, 'task-1');
    expect(await handlerFor(IPC.BROWSER_ANNOTATIONS_LOAD)(undefined, 'task-1')).toBeNull();
  });
});
