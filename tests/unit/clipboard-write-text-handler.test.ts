/**
 * Unit tests for the clipboard IPC handlers in src/main/ipc/handlers/system.ts:
 * CLIPBOARD_WRITE_TEXT and CLIPBOARD_READ_IMAGE.
 *
 * CLIPBOARD_WRITE_TEXT writes text to the native clipboard via Electron's
 * synchronous, focus-independent `clipboard.writeText`, guarded against
 * non-string and empty-string input:
 *
 *   ipcMain.handle(IPC.CLIPBOARD_WRITE_TEXT, (_event, text: string): void => {
 *     if (typeof text !== 'string' || text.length === 0) return;
 *     clipboard.writeText(text);
 *   });
 *
 * This guard matters because both the OSC 52 terminal handler and the
 * context-menu / Ctrl+C copy path forward whatever `cleanSelection` /
 * `decodeOsc52Payload` produce, which can legitimately be an empty string
 * (nothing selected, a malformed OSC 52 payload) - the handler must not hand
 * an empty write to the OS clipboard, and must not throw on a caller sending
 * an unexpected non-string.
 *
 * CLIPBOARD_READ_IMAGE reads the clipboard's NativeImage, caps it via the real
 * (unmocked) `capClipboardImage` before writing it to a temp file, and prunes
 * the temp directory via the real (unmocked) `pruneClipboardTempDir` first.
 * Those two helpers are unit-tested in isolation in clipboard-image.test.ts;
 * the tests here cover the WIRING - that the handler actually calls them,
 * rather than writing `image.toPNG()` straight to disk.
 *
 * Strategy mirrors keybindings-probe-handler.test.ts: mock electron's ipcMain
 * to capture registered handlers, then invoke the handler directly with
 * controlled inputs and assert against a mocked `clipboard.writeText` /
 * `clipboard.readImage`. `os.tmpdir()` is spied so CLIPBOARD_READ_IMAGE writes
 * under a throwaway test directory instead of the real
 * `<tmpdir>/kangentic-clipboard` the dogfooding app's own pastes live in.
 *
 * Tier: Unit (vitest, no browser, no Electron).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IPC } from '../../src/shared/ipc-channels';
import { IMAGE_LONG_EDGE_CAP, resolveResizeTarget } from '../../src/shared/image-fidelity';

// ---------------------------------------------------------------------------
// Hoisted mocks - must be declared before any imports that trigger them.
// ---------------------------------------------------------------------------

const { capturedHandlers, mockClipboard } = vi.hoisted(() => {
  const capturedHandlers = new Map<string, (...args: unknown[]) => unknown>();
  const mockClipboard = {
    writeText: vi.fn(),
    readImage: vi.fn(),
  };
  return { capturedHandlers, mockClipboard };
});

vi.mock('electron', () => ({
  app: { getVersion: vi.fn(() => '0.0.0'), getPath: vi.fn(() => '/tmp') },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      capturedHandlers.set(channel, handler);
    }),
    on: vi.fn(),
  },
  Notification: { isSupported: vi.fn(() => false) },
  dialog: { showOpenDialog: vi.fn() },
  shell: { openPath: vi.fn(), openExternal: vi.fn(), showItemInFolder: vi.fn() },
  globalShortcut: { isRegistered: vi.fn(() => false), register: vi.fn(() => true), unregister: vi.fn() },
  clipboard: mockClipboard,
}));

vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: {
    list: vi.fn(() => []),
    get: vi.fn(() => null),
    getOrThrow: vi.fn(),
    has: vi.fn(() => false),
  },
}));

vi.mock('../../src/main/git/worktree-manager', () => ({ WorktreeManager: class {} }));
vi.mock('../../src/main/git/git-checks', () => ({ isGitRepo: vi.fn(() => false) }));
vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn() }));
vi.mock('../../src/main/db/repositories/handoff-repository', () => ({
  HandoffRepository: class { listByTaskId = vi.fn(() => []); },
}));
vi.mock('../../src/shared/object-utils', () => ({
  deepMergeConfig: vi.fn((a: unknown, b: unknown) => ({ ...(a as object), ...(b as object) })),
}));
vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => ({ pid: 1234, unref: vi.fn() })),
  exec: vi.fn(),
  execFile: vi.fn(),
}));
vi.mock('../../src/main/config/apply-runtime-config', () => ({
  applyRuntimeConfig: vi.fn(),
}));
vi.mock('../../src/main/ipc/handlers/projects', () => ({
  syncProjectMcpConfig: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Import under test (after all mocks are registered).
// ---------------------------------------------------------------------------

import { registerSystemHandlers } from '../../src/main/ipc/handlers/system';

// ---------------------------------------------------------------------------
// Test context factory (minimal - the clipboard handler needs no project state).
// ---------------------------------------------------------------------------

function makeContext() {
  return {
    configManager: {
      load: vi.fn(() => ({
        agent: { cliPaths: {}, maxConcurrentSessions: 5, idleTimeoutMinutes: 30 },
        terminal: { shell: null },
        mcpServer: { enabled: false },
        autoNameRateLimitPerHour: 60,
      })),
      getEffectiveConfig: vi.fn(() => ({
        agent: { maxConcurrentSessions: 5, idleTimeoutMinutes: 30 },
        terminal: { shell: null },
      })),
      save: vi.fn(),
      saveProjectOverrides: vi.fn(),
      loadProjectOverrides: vi.fn(() => null),
    },
    sessionManager: {
      setMaxConcurrent: vi.fn(),
      setShell: vi.fn(),
      setIdleTimeout: vi.fn(),
    },
    boardConfigManager: { getDefaultBaseBranch: vi.fn(() => null) },
    projectRepo: { list: vi.fn(() => []) },
    shellResolver: { getAvailableShells: vi.fn(() => []), getDefaultShell: vi.fn(() => 'bash') },
    gitDetector: { detect: vi.fn(() => ({ found: false })) },
    mainWindow: {
      minimize: vi.fn(), maximize: vi.fn(), unmaximize: vi.fn(),
      isMaximized: vi.fn(() => false), close: vi.fn(), isFocused: vi.fn(() => true),
      flashFrame: vi.fn(), isDestroyed: vi.fn(() => false),
      isMinimized: vi.fn(() => false), restore: vi.fn(), show: vi.fn(),
      focus: vi.fn(), once: vi.fn(), webContents: { send: vi.fn() },
    },
    currentProjectPath: null,
    currentProjectId: null,
    mcpServerHandle: null,
  };
}

function invokeClipboardWriteTextHandler(text: unknown): void {
  const handler = capturedHandlers.get(IPC.CLIPBOARD_WRITE_TEXT);
  if (!handler) throw new Error(`Handler not registered for ${IPC.CLIPBOARD_WRITE_TEXT}`);
  handler(undefined, text);
}

function invokeClipboardReadImageHandler(): string | null {
  const handler = capturedHandlers.get(IPC.CLIPBOARD_READ_IMAGE);
  if (!handler) throw new Error(`Handler not registered for ${IPC.CLIPBOARD_READ_IMAGE}`);
  return handler(undefined) as string | null;
}

// ---------------------------------------------------------------------------
// Fake NativeImage for CLIPBOARD_READ_IMAGE - exposes exactly the surface
// capClipboardImage touches (getSize / resize / isEmpty) plus toPNG, with the
// resized image carrying its OWN toPNG spy so a test can tell whether the
// handler wrote the original or the resized bytes to disk.
// ---------------------------------------------------------------------------

interface FakeNativeImage {
  getSize: ReturnType<typeof vi.fn>;
  resize: ReturnType<typeof vi.fn>;
  isEmpty: ReturnType<typeof vi.fn>;
  toPNG: ReturnType<typeof vi.fn>;
}

function makeFakeNativeImage(width: number, height: number): {
  image: FakeNativeImage;
  resizedToPng: ReturnType<typeof vi.fn>;
} {
  const resizedToPng = vi.fn(() => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  // getSize/resize are never called on the RESIZED image by capClipboardImage
  // (only isEmpty/toPNG are); left unimplemented deliberately rather than
  // faked, so an accidental call surfaces as a clear stub failure.
  const resizedImage: FakeNativeImage = {
    getSize: vi.fn(),
    resize: vi.fn(),
    isEmpty: vi.fn(() => false),
    toPNG: resizedToPng,
  };
  const image: FakeNativeImage = {
    getSize: vi.fn(() => ({ width, height })),
    resize: vi.fn(() => resizedImage),
    isEmpty: vi.fn(() => false),
    toPNG: vi.fn(() => Buffer.from([0x89, 0x50, 0x4e, 0x47])),
  };
  return { image, resizedToPng };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CLIPBOARD_WRITE_TEXT IPC handler', () => {
  beforeEach(() => {
    capturedHandlers.clear();
    mockClipboard.writeText.mockReset();
    registerSystemHandlers(makeContext() as Parameters<typeof registerSystemHandlers>[0]);
  });

  it('writes a valid non-empty string to the native clipboard', () => {
    invokeClipboardWriteTextHandler('copied-text');

    expect(mockClipboard.writeText).toHaveBeenCalledWith('copied-text');
  });

  it('is a no-op for an empty string', () => {
    invokeClipboardWriteTextHandler('');

    expect(mockClipboard.writeText).not.toHaveBeenCalled();
  });

  it('is a no-op for null', () => {
    invokeClipboardWriteTextHandler(null);

    expect(mockClipboard.writeText).not.toHaveBeenCalled();
  });

  it('is a no-op for undefined', () => {
    invokeClipboardWriteTextHandler(undefined);

    expect(mockClipboard.writeText).not.toHaveBeenCalled();
  });

  it('is a no-op for a non-string number', () => {
    invokeClipboardWriteTextHandler(42);

    expect(mockClipboard.writeText).not.toHaveBeenCalled();
  });
});

describe('CLIPBOARD_READ_IMAGE IPC handler', () => {
  let testTmpRoot: string;
  let clipboardTempDir: string;

  beforeEach(() => {
    // Capture the real tmpdir with the real os.tmpdir() BEFORE spying it, then
    // redirect the handler's `path.join(os.tmpdir(), 'kangentic-clipboard')`
    // write target at this throwaway root. Without this, the handler would
    // write into (and this test's prune assertion would delete from) the same
    // directory the dogfooding app's own terminal pastes live in.
    testTmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-clipboard-handler-test-'));
    vi.spyOn(os, 'tmpdir').mockReturnValue(testTmpRoot);
    clipboardTempDir = path.join(testTmpRoot, 'kangentic-clipboard');

    capturedHandlers.clear();
    mockClipboard.readImage.mockReset();
    registerSystemHandlers(makeContext() as Parameters<typeof registerSystemHandlers>[0]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(testTmpRoot, { recursive: true, force: true });
  });

  it('caps an oversized clipboard image and writes the RESIZED bytes, not the original', () => {
    const { image, resizedToPng } = makeFakeNativeImage(4000, 2000);
    mockClipboard.readImage.mockReturnValue(image);

    const filePath = invokeClipboardReadImageHandler();

    expect(filePath).toBeTruthy();
    // Proves the write went through the throwaway test root, not the real
    // clipboard temp directory the dogfooding app uses.
    expect(filePath as string).toContain(testTmpRoot);

    // Reverting the handler to its old `fs.writeFileSync(filePath,
    // image.toPNG())` body would call the ORIGINAL image's toPNG, not the
    // resized one - this is the discriminating assertion for that revert.
    expect(image.toPNG).not.toHaveBeenCalled();
    expect(resizedToPng).toHaveBeenCalledOnce();

    // Resize target matches the shared long-edge cap resolver directly, so
    // this pins the wiring rather than re-deriving the expected numbers.
    const expectedTarget = resolveResizeTarget(4000, 2000, IMAGE_LONG_EDGE_CAP);
    expect(image.resize).toHaveBeenCalledWith({ ...expectedTarget, quality: 'best' });

    // The bytes actually on disk are the resized image's PNG output.
    const writtenBytes = fs.readFileSync(filePath as string);
    expect(writtenBytes).toEqual(resizedToPng.mock.results[0]?.value);
  });

  it('prunes stale pasted-image files from the temp dir before writing the new paste', () => {
    fs.mkdirSync(clipboardTempDir, { recursive: true });
    const staleFilePath = path.join(clipboardTempDir, 'pasted-image-old.png');
    fs.writeFileSync(staleFilePath, 'stale-png-bytes');
    // 48h old - past the 24h default max age pruneClipboardTempDir applies
    // when the handler calls it with no options.
    const fortyEightHoursAgoSeconds = (Date.now() - 48 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(staleFilePath, fortyEightHoursAgoSeconds, fortyEightHoursAgoSeconds);

    const { image } = makeFakeNativeImage(800, 600); // already fits, no resize needed
    mockClipboard.readImage.mockReturnValue(image);

    const filePath = invokeClipboardReadImageHandler();

    // Reverting the handler to skip pruneClipboardTempDir(tempDir) leaves this
    // stale file in place - it is the discriminating assertion for that
    // revert.
    expect(fs.existsSync(staleFilePath)).toBe(false);
    // The new paste itself must still have been written.
    expect(filePath).toBeTruthy();
    expect(fs.existsSync(filePath as string)).toBe(true);
  });

  it('returns null when the clipboard holds no image', () => {
    mockClipboard.readImage.mockReturnValue({ isEmpty: () => true });

    const filePath = invokeClipboardReadImageHandler();

    expect(filePath).toBeNull();
  });

  it('degrades to null instead of throwing when writing the capped image fails', () => {
    // Pre-diff this handler had no try/catch at all: any fs failure (disk full,
    // a Windows AV scanner holding the just-created temp file, a foreign-owned
    // /tmp on shared Linux) became a rejected invoke in the renderer. The
    // handler now wraps the write in try/catch and degrades to the same null an
    // empty clipboard returns, logging a trace instead. That degrade branch has
    // no other covering assertion - this pins it directly.
    const { image } = makeFakeNativeImage(800, 600); // already fits, no resize needed
    mockClipboard.readImage.mockReturnValue(image);

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw new Error('ENOSPC: no space left on device, write');
    });

    let filePath: string | null = null;
    expect(() => {
      filePath = invokeClipboardReadImageHandler();
    }).not.toThrow();

    expect(filePath).toBeNull();
    // The other half of the documented contract: degrade quietly to the
    // renderer, but still leave a trace for whoever is debugging a paste that
    // silently did nothing.
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '[clipboard] Failed to save pasted image:',
      expect.any(Error),
    );
  });
});
