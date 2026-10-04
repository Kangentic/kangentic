/**
 * Unit tests for the clipboard IPC handlers in src/main/ipc/handlers/system.ts:
 * CLIPBOARD_WRITE_TEXT and CLIPBOARD_READ_IMAGE.
 *
 * CLIPBOARD_WRITE_TEXT writes text to the native clipboard via Electron's
 * focus-independent `clipboard.writeText` (a promise since Electron 44), guarded
 * against non-string and empty-string input:
 *
 *   ipcMain.handle(IPC.CLIPBOARD_WRITE_TEXT, async (_event, text: string): Promise<void> => {
 *     if (typeof text !== 'string' || text.length === 0) return;
 *     await clipboard.writeText(text);
 *   });
 *
 * This guard matters because both the OSC 52 terminal handler and the
 * context-menu / Ctrl+C copy path forward whatever `cleanSelection` /
 * `decodeOsc52Payload` produce, which can legitimately be an empty string
 * (nothing selected, a malformed OSC 52 payload) - the handler must not hand
 * an empty write to the OS clipboard, and must not throw on a caller sending
 * an unexpected non-string.
 *
 * CLIPBOARD_READ_IMAGE reads the clipboard's image through Electron 44's async
 * `clipboard.read()` (the first `image/*` Blob that `nativeImage` decodes), caps
 * it via the real (unmocked) `capClipboardImage` before writing it to a temp
 * file, and prunes the temp directory via the real (unmocked)
 * `pruneClipboardTempDir` first. Those two helpers are unit-tested in isolation
 * in clipboard-image.test.ts; the tests here cover the WIRING - that the handler
 * actually calls them, rather than writing `image.toPNG()` straight to disk.
 *
 * The last two describe blocks call `readClipboardImage` and `writeClipboardImage`
 * directly, with plain fakes for the clipboard, the decoder, and the
 * ClipboardItem constructor. The handler tests reach `readClipboardImage` with one
 * item and one decodable type, so they never exercise its skip-to-next paths, and
 * `writeClipboardImage` (the Copy Image context menu) has no handler at all: it is
 * called from the menu click in src/main/index.ts.
 *
 * Strategy mirrors keybindings-probe-handler.test.ts: mock electron's ipcMain
 * to capture registered handlers, then invoke the handler directly with
 * controlled inputs and assert against a mocked `clipboard.writeText` /
 * `clipboard.read`. `os.tmpdir()` is spied so CLIPBOARD_READ_IMAGE writes
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

const { capturedHandlers, mockClipboard, mockNativeImage } = vi.hoisted(() => {
  const capturedHandlers = new Map<string, (...args: unknown[]) => unknown>();
  const mockClipboard = {
    writeText: vi.fn(async (): Promise<void> => {}),
    read: vi.fn(),
  };
  const mockNativeImage = {
    createFromBuffer: vi.fn(),
  };
  return { capturedHandlers, mockClipboard, mockNativeImage };
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
  nativeImage: mockNativeImage,
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
import { readClipboardImage, writeClipboardImage } from '../../src/main/ipc/helpers/clipboard-image';

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

async function invokeClipboardWriteTextHandler(text: unknown): Promise<void> {
  const handler = capturedHandlers.get(IPC.CLIPBOARD_WRITE_TEXT);
  if (!handler) throw new Error(`Handler not registered for ${IPC.CLIPBOARD_WRITE_TEXT}`);
  await handler(undefined, text);
}

async function invokeClipboardReadImageHandler(): Promise<string | null> {
  const handler = capturedHandlers.get(IPC.CLIPBOARD_READ_IMAGE);
  if (!handler) throw new Error(`Handler not registered for ${IPC.CLIPBOARD_READ_IMAGE}`);
  return (await handler(undefined)) as string | null;
}

/** A `clipboard.read()` item, shaped like Electron 44's ClipboardItem: its MIME
 *  types, and a Blob per type. */
function makeClipboardItem(payloads: Record<string, string>): { types: string[]; getType: (type: string) => Promise<Blob> } {
  return {
    types: Object.keys(payloads),
    getType: async (type: string) => new Blob([payloads[type]], { type }),
  };
}

/** The clipboard holding one image, whose PNG bytes decode to `image`. */
function clipboardHoldsImage(image: unknown): void {
  mockClipboard.read.mockResolvedValue([makeClipboardItem({ 'text/plain': 'caption', 'image/png': 'png-bytes' })]);
  mockNativeImage.createFromBuffer.mockReturnValue(image);
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

  it('writes a valid non-empty string to the native clipboard', async () => {
    await invokeClipboardWriteTextHandler('copied-text');

    expect(mockClipboard.writeText).toHaveBeenCalledWith('copied-text');
  });

  it('passes a failed write on to the renderer, which has its own catch', async () => {
    mockClipboard.writeText.mockRejectedValueOnce(new Error('clipboard busy'));

    await expect(invokeClipboardWriteTextHandler('copied-text')).rejects.toThrow('clipboard busy');
  });

  it('is a no-op for an empty string', async () => {
    await invokeClipboardWriteTextHandler('');

    expect(mockClipboard.writeText).not.toHaveBeenCalled();
  });

  it('is a no-op for null', async () => {
    await invokeClipboardWriteTextHandler(null);

    expect(mockClipboard.writeText).not.toHaveBeenCalled();
  });

  it('is a no-op for undefined', async () => {
    await invokeClipboardWriteTextHandler(undefined);

    expect(mockClipboard.writeText).not.toHaveBeenCalled();
  });

  it('is a no-op for a non-string number', async () => {
    await invokeClipboardWriteTextHandler(42);

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
    mockClipboard.read.mockReset();
    mockNativeImage.createFromBuffer.mockReset();
    registerSystemHandlers(makeContext() as Parameters<typeof registerSystemHandlers>[0]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(testTmpRoot, { recursive: true, force: true });
  });

  it('decodes the image/png payload, not the other types the item carries', async () => {
    const { image } = makeFakeNativeImage(800, 600);
    clipboardHoldsImage(image);

    expect(await invokeClipboardReadImageHandler()).toBeTruthy();
    const decoded = mockNativeImage.createFromBuffer.mock.calls[0]?.[0] as Buffer;
    expect(mockNativeImage.createFromBuffer).toHaveBeenCalledOnce();
    expect(decoded.toString()).toBe('png-bytes');
  });

  it('caps an oversized clipboard image and writes the RESIZED bytes, not the original', async () => {
    const { image, resizedToPng } = makeFakeNativeImage(4000, 2000);
    clipboardHoldsImage(image);

    const filePath = await invokeClipboardReadImageHandler();

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

  it('prunes stale pasted-image files from the temp dir before writing the new paste', async () => {
    fs.mkdirSync(clipboardTempDir, { recursive: true });
    const staleFilePath = path.join(clipboardTempDir, 'pasted-image-old.png');
    fs.writeFileSync(staleFilePath, 'stale-png-bytes');
    // 48h old - past the 24h default max age pruneClipboardTempDir applies
    // when the handler calls it with no options.
    const fortyEightHoursAgoSeconds = (Date.now() - 48 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(staleFilePath, fortyEightHoursAgoSeconds, fortyEightHoursAgoSeconds);

    const { image } = makeFakeNativeImage(800, 600); // already fits, no resize needed
    clipboardHoldsImage(image);

    const filePath = await invokeClipboardReadImageHandler();

    // Reverting the handler to skip pruneClipboardTempDir(tempDir) leaves this
    // stale file in place - it is the discriminating assertion for that
    // revert.
    expect(fs.existsSync(staleFilePath)).toBe(false);
    // The new paste itself must still have been written.
    expect(filePath).toBeTruthy();
    expect(fs.existsSync(filePath as string)).toBe(true);
  });

  it('returns null when the clipboard is empty', async () => {
    mockClipboard.read.mockResolvedValue([]);

    expect(await invokeClipboardReadImageHandler()).toBeNull();
  });

  it('returns null without decoding anything when no item carries an image type', async () => {
    mockClipboard.read.mockResolvedValue([makeClipboardItem({ 'text/plain': 'just text', 'text/html': '<b>just text</b>' })]);

    expect(await invokeClipboardReadImageHandler()).toBeNull();
    expect(mockNativeImage.createFromBuffer).not.toHaveBeenCalled();
  });

  it('returns null when the image payload does not decode', async () => {
    clipboardHoldsImage({ isEmpty: () => true });

    expect(await invokeClipboardReadImageHandler()).toBeNull();
  });

  it('degrades to null instead of rejecting when the clipboard cannot be read', async () => {
    // readImage() could not fail. read() can, for one when another app holds the
    // clipboard open, and a rejection would surface as an unhandled one in the
    // renderer's paste path.
    mockClipboard.read.mockRejectedValue(new Error('OpenClipboard failed'));
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(invokeClipboardReadImageHandler()).resolves.toBeNull();
    expect(consoleErrorSpy).toHaveBeenCalledWith('[clipboard] Failed to read the clipboard image:', expect.any(Error));
  });

  it('degrades to null instead of throwing when writing the capped image fails', async () => {
    // Pre-diff this handler had no try/catch at all: any fs failure (disk full,
    // a Windows AV scanner holding the just-created temp file, a foreign-owned
    // /tmp on shared Linux) became a rejected invoke in the renderer. The
    // handler now wraps the write in try/catch and degrades to the same null an
    // empty clipboard returns, logging a trace instead. That degrade branch has
    // no other covering assertion - this pins it directly.
    const { image } = makeFakeNativeImage(800, 600); // already fits, no resize needed
    clipboardHoldsImage(image);

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw new Error('ENOSPC: no space left on device, write');
    });

    await expect(invokeClipboardReadImageHandler()).resolves.toBeNull();
    // The other half of the documented contract: degrade quietly to the
    // renderer, but still leave a trace for whoever is debugging a paste that
    // silently did nothing.
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '[clipboard] Failed to save pasted image:',
      expect.any(Error),
    );
  });
});

describe('CLIPBOARD_SAVE_IMAGE IPC handler', () => {
  // The drop-path twin of CLIPBOARD_READ_IMAGE: the renderer decodes a dropped
  // image the agent cannot take as-is (a bmp) into PNG bytes, and this handler
  // lands them in the same temp directory under the same cap and prune. The
  // decode in main is a validity check on bytes that are already PNG.
  let testTmpRoot: string;

  function invokeClipboardSaveImageHandler(png: unknown): string | null {
    const handler = capturedHandlers.get(IPC.CLIPBOARD_SAVE_IMAGE);
    if (!handler) throw new Error(`Handler not registered for ${IPC.CLIPBOARD_SAVE_IMAGE}`);
    return handler(undefined, png) as string | null;
  }

  beforeEach(() => {
    testTmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-clipboard-handler-test-'));
    vi.spyOn(os, 'tmpdir').mockReturnValue(testTmpRoot);
    capturedHandlers.clear();
    mockNativeImage.createFromBuffer.mockReset();
    registerSystemHandlers(makeContext() as Parameters<typeof registerSystemHandlers>[0]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(testTmpRoot, { recursive: true, force: true });
  });

  it('decodes the bytes, caps the image, and writes it beside the clipboard captures', () => {
    const { image, resizedToPng } = makeFakeNativeImage(4000, 2000);
    mockNativeImage.createFromBuffer.mockReturnValue(image);
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

    const filePath = invokeClipboardSaveImageHandler(pngBytes);

    expect(filePath).toBeTruthy();
    expect(filePath as string).toContain(path.join(testTmpRoot, 'kangentic-clipboard'));
    expect(path.basename(filePath as string)).toMatch(/^pasted-image-\d+\.png$/);
    // The handler hands nativeImage exactly the bytes it received, as a Buffer
    // view rather than a copy of some other slice.
    const decoded = mockNativeImage.createFromBuffer.mock.calls[0]?.[0] as Buffer;
    expect(Buffer.isBuffer(decoded)).toBe(true);
    expect([...decoded]).toEqual([...pngBytes]);
    // Same cap as the clipboard path: the oversized fake was resized and the
    // RESIZED bytes were written.
    expect(resizedToPng).toHaveBeenCalledOnce();
    expect(fs.readFileSync(filePath as string)).toEqual(resizedToPng.mock.results[0]?.value);
  });

  it('returns null for bytes that do not decode, without writing anything', () => {
    mockNativeImage.createFromBuffer.mockReturnValue({ isEmpty: () => true });

    const filePath = invokeClipboardSaveImageHandler(new Uint8Array([1, 2, 3]));

    expect(filePath).toBeNull();
    expect(fs.existsSync(path.join(testTmpRoot, 'kangentic-clipboard'))).toBe(false);
  });

  it('returns null for a payload that is not a byte array, without touching nativeImage', () => {
    expect(invokeClipboardSaveImageHandler('not bytes')).toBeNull();
    expect(invokeClipboardSaveImageHandler(new Uint8Array(0))).toBeNull();
    expect(invokeClipboardSaveImageHandler(undefined)).toBeNull();
    expect(mockNativeImage.createFromBuffer).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// readClipboardImage and writeClipboardImage, called directly. The fakes are
// plain objects; the electron types are derived from the functions' own
// signatures so this file needs no import from 'electron' for them.
// ---------------------------------------------------------------------------

type ClipboardSource = Parameters<typeof readClipboardImage>[0];
type DecodedImage = ReturnType<Parameters<typeof readClipboardImage>[1]>;

/** A stand-in for a decoded NativeImage. The label only makes a failed identity
 *  assertion readable. */
function makeDecodedImage(label: string, isEmpty: boolean): DecodedImage {
  return { label, isEmpty: () => isEmpty } as unknown as DecodedImage;
}

function makeBlob(text: string, type: string): Blob {
  return new Blob([text], { type });
}

/** A `clipboard.read()` item whose `getType` resolves whatever is scripted for a
 *  type, so a test can hand back something that is not a Blob. */
function makeScriptedItem(payloadsByType: Record<string, unknown>) {
  return {
    types: Object.keys(payloadsByType),
    getType: vi.fn(async (type: string): Promise<unknown> => payloadsByType[type]),
  };
}

function makeClipboardSource(items: ReturnType<typeof makeScriptedItem>[]): ClipboardSource {
  return { read: vi.fn(async () => items) } as unknown as ClipboardSource;
}

/** Decodes by the payload's text. Bytes with no mapping decode to an EMPTY image,
 *  never undefined: an undefined result would make `image.isEmpty()` throw, the
 *  catch in readClipboardImage would return null, and a test could go red or
 *  green for that reason instead of the one it names. */
function makeDecoder(imagesByPayloadText: Record<string, DecodedImage>) {
  const undecodableImage = makeDecodedImage('unmapped bytes', true);
  return vi.fn((bytes: Buffer): DecodedImage => imagesByPayloadText[bytes.toString()] ?? undecodableImage);
}

function decodedPayloadTexts(decode: ReturnType<typeof makeDecoder>): string[] {
  return decode.mock.calls.map(([bytes]) => bytes.toString());
}

describe('readClipboardImage skip-to-next behavior', () => {
  // The skip cases below are built from the two PREFERRED types (png, then jpeg),
  // so the decodable-first ordering cannot make them pass on its own: each one
  // needs the loop to move on past a type or an item that yielded nothing.

  it('skips an image/png that decodes to an empty image and returns the image/jpeg', async () => {
    const jpegImage = makeDecodedImage('jpeg', false);
    const decode = makeDecoder({ 'png-bytes': makeDecodedImage('empty png', true), 'jpeg-bytes': jpegImage });
    const item = makeScriptedItem({
      'image/png': makeBlob('png-bytes', 'image/png'),
      'image/jpeg': makeBlob('jpeg-bytes', 'image/jpeg'),
    });

    const image = await readClipboardImage(makeClipboardSource([item]), decode);

    expect(image).toBe(jpegImage);
    expect(decodedPayloadTexts(decode)).toEqual(['png-bytes', 'jpeg-bytes']);
  });

  it('skips an image/png payload that is not a Blob and returns the image/jpeg', async () => {
    const jpegImage = makeDecodedImage('jpeg', false);
    const decode = makeDecoder({ 'jpeg-bytes': jpegImage });
    const item = makeScriptedItem({
      'image/png': 'a string, not a Blob',
      'image/jpeg': makeBlob('jpeg-bytes', 'image/jpeg'),
    });

    const image = await readClipboardImage(makeClipboardSource([item]), decode);

    expect(image).toBe(jpegImage);
    // Only the jpeg reached the decoder: the string payload was skipped, not decoded.
    expect(decodedPayloadTexts(decode)).toEqual(['jpeg-bytes']);
  });

  it('moves on to the next clipboard item when the first one yields no image', async () => {
    const secondItemImage = makeDecodedImage('second item png', false);
    const decode = makeDecoder({
      'first-jpeg-bytes': makeDecodedImage('empty jpeg', true),
      'second-png-bytes': secondItemImage,
    });
    // The first item offers both preferred types and neither produces an image:
    // the png is not a Blob and the jpeg decodes to an empty image.
    const firstItem = makeScriptedItem({
      'image/png': 'a string, not a Blob',
      'image/jpeg': makeBlob('first-jpeg-bytes', 'image/jpeg'),
    });
    const secondItem = makeScriptedItem({ 'image/png': makeBlob('second-png-bytes', 'image/png') });

    const image = await readClipboardImage(makeClipboardSource([firstItem, secondItem]), decode);

    expect(image).toBe(secondItemImage);
    expect(decodedPayloadTexts(decode)).toEqual(['first-jpeg-bytes', 'second-png-bytes']);
  });

  it('fetches the decodable image/png before an image type listed ahead of it, and never fetches the other', async () => {
    const pngImage = makeDecodedImage('png', false);
    // The tiff WOULD decode to a non-empty image if it were asked for, so a loop
    // that went in listed order would return it and fail on the identity check
    // as well as on the getType calls.
    const decode = makeDecoder({
      'tiff-bytes': makeDecodedImage('tiff', false),
      'png-bytes': pngImage,
    });
    const item = makeScriptedItem({
      'image/tiff': makeBlob('tiff-bytes', 'image/tiff'),
      'image/png': makeBlob('png-bytes', 'image/png'),
    });
    expect(item.types).toEqual(['image/tiff', 'image/png']);

    const image = await readClipboardImage(makeClipboardSource([item]), decode);

    expect(image).toBe(pngImage);
    expect(item.getType.mock.calls.map(([type]) => type)).toEqual(['image/png']);
  });
});

describe('writeClipboardImage', () => {
  type CopiedImage = Parameters<typeof writeClipboardImage>[0];
  type WriteTarget = Parameters<typeof writeClipboardImage>[1];
  type ClipboardItemFake = ReturnType<Parameters<typeof writeClipboardImage>[2]>;

  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 8, 9]);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Both flavours carry a working `toPNG`. The empty-image early return sits
   *  OUTSIDE writeClipboardImage's try, so a fake whose `toPNG` threw would let a
   *  dropped early return fail inside the try, be swallowed by the catch, and
   *  leave the empty-image test green against the mutation. */
  function makeImage(isEmpty: boolean) {
    return { isEmpty: vi.fn(() => isEmpty), toPNG: vi.fn(() => pngBytes) };
  }

  /** Fresh fakes per test, so no call history carries across cases. */
  function makeClipboardTarget() {
    const clipboardItem = { label: 'the item createClipboardItem returned' } as unknown as ClipboardItemFake;
    const write = vi.fn<(items: unknown[]) => Promise<void>>().mockResolvedValue(undefined);
    const createClipboardItem = vi.fn<(payloads: Record<string, Blob>) => ClipboardItemFake>(() => clipboardItem);
    return { clipboardItem, write, createClipboardItem, clipboardTarget: { write } as unknown as WriteTarget };
  }

  it('writes nothing for an empty image, so a failed decode cannot blank the clipboard', async () => {
    const image = makeImage(true);
    const { write, createClipboardItem, clipboardTarget } = makeClipboardTarget();
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await writeClipboardImage(image as unknown as CopiedImage, clipboardTarget, createClipboardItem);

    expect(write).not.toHaveBeenCalled();
    expect(createClipboardItem).not.toHaveBeenCalled();
    expect(image.toPNG).not.toHaveBeenCalled();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('puts the image on the clipboard as one image/png ClipboardItem holding the toPNG bytes', async () => {
    const image = makeImage(false);
    const { clipboardItem, write, createClipboardItem, clipboardTarget } = makeClipboardTarget();
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await writeClipboardImage(image as unknown as CopiedImage, clipboardTarget, createClipboardItem);

    expect(createClipboardItem).toHaveBeenCalledOnce();
    const payloads = createClipboardItem.mock.calls[0][0];
    expect(Object.keys(payloads)).toEqual(['image/png']);
    const pngPayload = payloads['image/png'];
    expect(pngPayload).toBeInstanceOf(Blob);
    expect(pngPayload.type).toBe('image/png');
    expect([...new Uint8Array(await pngPayload.arrayBuffer())]).toEqual([...pngBytes]);

    expect(write).toHaveBeenCalledOnce();
    const writtenItems = write.mock.calls[0][0];
    expect(writtenItems).toHaveLength(1);
    expect(writtenItems[0]).toBe(clipboardItem);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('resolves instead of rejecting when the clipboard write fails, and logs the failure', async () => {
    const image = makeImage(false);
    const { write, createClipboardItem, clipboardTarget } = makeClipboardTarget();
    const writeError = new Error('clipboard busy');
    write.mockRejectedValue(writeError);
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      writeClipboardImage(image as unknown as CopiedImage, clipboardTarget, createClipboardItem),
    ).resolves.toBeUndefined();

    expect(write).toHaveBeenCalledOnce();
    expect(consoleErrorSpy).toHaveBeenCalledOnce();
    expect(consoleErrorSpy).toHaveBeenCalledWith('[clipboard] Copy Image failed:', writeError);
  });
});
