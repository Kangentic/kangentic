/**
 * Unit tests for the WINDOW_CAPTURE_REGION IPC handler in
 * src/main/ipc/handlers/system.ts ('window:captureRegion').
 *
 * The Command Terminal's header swap drag takes a picture of the pressed
 * terminal on the press (`swap-drag.ts`). The renderer measures the terminal in
 * CSS pixels and sends the rect; this handler captures the SENDER's own page, so
 * a terminal dragged in the detached Command Terminal window pictures that window
 * and not the main one. `capturePage` takes the page's DIPs, so the rect is scaled
 * by the sender's zoom factor first:
 *
 *   - a rect that is not four finite numbers with a positive size answers null
 *     without ever reaching `capturePage`;
 *   - a valid rect is scaled by `getZoomFactor()` and rounded, per field;
 *   - an empty image, or a `capturePage` that throws or rejects, answers null;
 *   - a sender destroyed since it asked (Electron throws on any call to a
 *     destroyed WebContents, `getZoomFactor()` included) answers null;
 *   - success answers a `data:image/jpeg;base64,` string at quality 90.
 *
 * UI tests use the mock electronAPI, so nothing else reaches this handler.
 *
 * Strategy mirrors clipboard-write-text-handler.test.ts: mock electron's ipcMain
 * to capture registered handlers, then invoke the handler directly.
 *
 * Tier: Unit (vitest, no browser, no Electron).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IPC } from '../../src/shared/ipc-channels';

// ---------------------------------------------------------------------------
// Hoisted mocks - must be declared before any imports that trigger them.
// ---------------------------------------------------------------------------

const { capturedHandlers } = vi.hoisted(() => ({
  capturedHandlers: new Map<string, (...args: unknown[]) => unknown>(),
}));

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
  clipboard: { writeText: vi.fn(), read: vi.fn() },
  nativeImage: { createFromBuffer: vi.fn() },
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
  deepMergeConfig: vi.fn((base: unknown, overrides: unknown) => ({ ...(base as object), ...(overrides as object) })),
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
// Fixtures
// ---------------------------------------------------------------------------

const JPEG_BYTES = Buffer.from('fake-jpeg-bytes');
const JPEG_DATA_URL = `data:image/jpeg;base64,${JPEG_BYTES.toString('base64')}`;
const VALID_RECT = { x: 10, y: 7, width: 101, height: 33 };

interface FakeCapturedImage {
  isEmpty: ReturnType<typeof vi.fn>;
  toJPEG: ReturnType<typeof vi.fn>;
}

/** Both flavours carry a working `toJPEG`. The empty-image early return sits
 *  inside the handler's try, so a fake whose `toJPEG` threw would let a dropped
 *  `isEmpty` check fail in the try, be swallowed by the catch, and leave the
 *  empty-image test green against the mutation. */
function makeCapturedImage(isEmpty: boolean): FakeCapturedImage {
  return { isEmpty: vi.fn(() => isEmpty), toJPEG: vi.fn(() => JPEG_BYTES) };
}

function makeSender(zoomFactor: number) {
  return {
    getZoomFactor: vi.fn(() => zoomFactor),
    capturePage: vi.fn(async (): Promise<FakeCapturedImage> => makeCapturedImage(false)),
  };
}

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

async function invokeCaptureRegion(sender: ReturnType<typeof makeSender>, rect: unknown): Promise<string | null> {
  const handler = capturedHandlers.get(IPC.WINDOW_CAPTURE_REGION);
  if (!handler) throw new Error(`Handler not registered for ${IPC.WINDOW_CAPTURE_REGION}`);
  return (await handler({ sender }, rect)) as string | null;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WINDOW_CAPTURE_REGION IPC handler', () => {
  beforeEach(() => {
    capturedHandlers.clear();
    registerSystemHandlers(makeContext() as Parameters<typeof registerSystemHandlers>[0]);
  });

  describe('a malformed rect', () => {
    // capturePage answers a valid image in every case, so a dropped guard shows
    // up as a data URL where null is owed, not as a throw the catch would hide.
    const MALFORMED_RECTS: Array<[string, unknown]> = [
      ['undefined', undefined],
      ['null', null],
      ['a string', '10,10,100,100'],
      ['a number', 42],
      ['an empty object', {}],
      ['a rect missing its height', { x: 0, y: 0, width: 100 }],
      ['a NaN x', { ...VALID_RECT, x: Number.NaN }],
      ['an Infinity y', { ...VALID_RECT, y: Number.POSITIVE_INFINITY }],
      ['a negative Infinity width', { ...VALID_RECT, width: Number.NEGATIVE_INFINITY }],
      ['a NaN height', { ...VALID_RECT, height: Number.NaN }],
      ['a numeric string field', { ...VALID_RECT, width: '101' }],
      ['a zero width', { ...VALID_RECT, width: 0 }],
      ['a negative width', { ...VALID_RECT, width: -5 }],
      ['a zero height', { ...VALID_RECT, height: 0 }],
      ['a negative height', { ...VALID_RECT, height: -1 }],
    ];

    it.each(MALFORMED_RECTS)('answers null without capturing for %s', async (_label, rect) => {
      const sender = makeSender(1);

      await expect(invokeCaptureRegion(sender, rect)).resolves.toBeNull();

      expect(sender.capturePage).not.toHaveBeenCalled();
    });
  });

  describe('a valid rect', () => {
    it('scales every field by the sender\'s zoom factor and rounds each one', async () => {
      const sender = makeSender(1.25);

      await invokeCaptureRegion(sender, VALID_RECT);

      // 12.5 rounds to 13 (a floor gives 12), 8.75 to 9 (a floor gives 8),
      // 126.25 to 126 (a ceil gives 127), 41.25 to 41 (a ceil gives 42).
      expect(sender.capturePage).toHaveBeenCalledTimes(1);
      expect(sender.capturePage).toHaveBeenCalledWith({ x: 13, y: 9, width: 126, height: 41 });
    });

    it('passes the rect through unchanged at a zoom factor of 1', async () => {
      const sender = makeSender(1);

      await invokeCaptureRegion(sender, VALID_RECT);

      expect(sender.capturePage).toHaveBeenCalledWith(VALID_RECT);
    });

    it('allows a rect at the origin and a fractional size that rounds to a pixel', async () => {
      const sender = makeSender(1);

      await invokeCaptureRegion(sender, { x: 0, y: 0, width: 0.6, height: 0.6 });

      expect(sender.capturePage).toHaveBeenCalledWith({ x: 0, y: 0, width: 1, height: 1 });
    });

    it('reads the zoom from the sender, so a zoomed page captures more device pixels', async () => {
      const sender = makeSender(2);

      await invokeCaptureRegion(sender, VALID_RECT);

      expect(sender.getZoomFactor).toHaveBeenCalledTimes(1);
      expect(sender.capturePage).toHaveBeenCalledWith({ x: 20, y: 14, width: 202, height: 66 });
    });

    it('answers a JPEG data URL encoded at quality 90', async () => {
      const image = makeCapturedImage(false);
      const sender = makeSender(1);
      sender.capturePage.mockResolvedValue(image);

      const result = await invokeCaptureRegion(sender, VALID_RECT);

      expect(result).toBe(JPEG_DATA_URL);
      expect(image.toJPEG).toHaveBeenCalledWith(90);
    });
  });

  describe('a capture that does not produce a picture', () => {
    it('answers null for an empty image', async () => {
      const image = makeCapturedImage(true);
      const sender = makeSender(1);
      sender.capturePage.mockResolvedValue(image);

      await expect(invokeCaptureRegion(sender, VALID_RECT)).resolves.toBeNull();

      expect(image.isEmpty).toHaveBeenCalledTimes(1);
      // Not encoded: an empty image has nothing to turn into a data URL.
      expect(image.toJPEG).not.toHaveBeenCalled();
    });

    it('answers null when capturePage rejects', async () => {
      const sender = makeSender(1);
      sender.capturePage.mockRejectedValue(new Error('Failed to capture the page'));

      await expect(invokeCaptureRegion(sender, VALID_RECT)).resolves.toBeNull();
    });

    it('answers null for a sender destroyed since it asked', async () => {
      const sender = makeSender(1);
      sender.getZoomFactor.mockImplementation(() => {
        throw new Error('Object has been destroyed');
      });

      await expect(invokeCaptureRegion(sender, VALID_RECT)).resolves.toBeNull();

      expect(sender.capturePage).not.toHaveBeenCalled();
    });

    it('answers null when capturePage throws synchronously', async () => {
      const sender = makeSender(1);
      sender.capturePage.mockImplementation(() => {
        throw new Error('Object has been destroyed');
      });

      await expect(invokeCaptureRegion(sender, VALID_RECT)).resolves.toBeNull();
    });

    it('answers null when encoding the image throws', async () => {
      const image = makeCapturedImage(false);
      image.toJPEG.mockImplementation(() => {
        throw new Error('encode failed');
      });
      const sender = makeSender(1);
      sender.capturePage.mockResolvedValue(image);

      await expect(invokeCaptureRegion(sender, VALID_RECT)).resolves.toBeNull();
    });
  });
});
