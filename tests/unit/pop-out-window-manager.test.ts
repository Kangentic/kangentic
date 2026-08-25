/**
 * Unit tests for PopOutWindowManager.open() (src/main/pop-out/pop-out-window-manager.ts) -
 * the only other place besides createWindow() allowed to construct a real OS BrowserWindow
 * (see .claude/rules/pop-out-surface-registry.md). Electron's BrowserWindow / nativeImage /
 * screen, and the window-utils bounds/icon helpers, are mocked so this suite is pure Node.
 * POP_OUT_SURFACES, resolveSurfaceTitle, and cascadePopOutPosition are the REAL,
 * already-unit-tested pure modules (see pop-out-cascade.test.ts), so these tests pin only
 * the wiring between them and the constructed window, not their own math.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PopOutChangesFileParams } from '../../src/shared/pop-out';

// vi.mock() calls are hoisted above every other statement in this file, so any
// outer variable a factory references must be declared through vi.hoisted() -
// otherwise the factory would run before its own `const` initializer.
const { mockResolveBackgroundColor, mockResolveIconPath, mockResolveRendererIndexPath, mockResolvePopOutBounds, mockSavePopOutBounds } = vi.hoisted(() => ({
  mockResolveBackgroundColor: vi.fn(() => '#18181b'),
  mockResolveIconPath: vi.fn(() => '/mock/icon.png'),
  mockResolveRendererIndexPath: vi.fn(() => '/mock/renderer/index.html'),
  mockResolvePopOutBounds: vi.fn(
    (): { x: number; y: number; width: number; height: number; maximized: boolean } | null => null,
  ),
  mockSavePopOutBounds: vi.fn(),
}));

vi.mock('../../src/main/window-utils', () => ({
  resolveBackgroundColor: mockResolveBackgroundColor,
  resolveIconPath: mockResolveIconPath,
  resolveRendererIndexPath: mockResolveRendererIndexPath,
  resolvePopOutBounds: mockResolvePopOutBounds,
  savePopOutBounds: mockSavePopOutBounds,
}));

const { MOCK_WORK_AREA, MOCK_DEFAULT_POSITION } = vi.hoisted(() => ({
  MOCK_WORK_AREA: { x: 0, y: 0, width: 1920, height: 1080 },
  MOCK_DEFAULT_POSITION: { x: 110, y: 90 },
}));

vi.mock('electron', () => {
  const { EventEmitter } = require('node:events');

  class MockWebContents extends EventEmitter {
    send = vi.fn();
  }

  class MockBrowserWindow extends EventEmitter {
    options: Record<string, unknown>;
    webContents: MockWebContents;
    setIcon = vi.fn();
    loadURL = vi.fn();
    loadFile = vi.fn();
    focus = vi.fn();
    restore = vi.fn();
    show = vi.fn();
    maximize = vi.fn(() => {
      this.maximized = true;
    });
    setPosition = vi.fn((x: number, y: number) => {
      this.bounds = { ...this.bounds, x, y };
    });
    private destroyed = false;
    private minimized = false;
    private maximized = false;
    private bounds: { x: number; y: number; width: number; height: number };

    constructor(options: Record<string, unknown>) {
      super();
      this.options = options;
      this.webContents = new MockWebContents();
      this.bounds = {
        x: typeof options.x === 'number' ? options.x : MOCK_DEFAULT_POSITION.x,
        y: typeof options.y === 'number' ? options.y : MOCK_DEFAULT_POSITION.y,
        width: typeof options.width === 'number' ? options.width : 900,
        height: typeof options.height === 'number' ? options.height : 700,
      };
    }

    isDestroyed(): boolean {
      return this.destroyed;
    }
    isMinimized(): boolean {
      return this.minimized;
    }
    isMaximized(): boolean {
      return this.maximized;
    }
    getBounds() {
      return this.bounds;
    }
    close(): void {
      this.destroy();
    }
    destroy(): void {
      if (this.destroyed) return;
      this.destroyed = true;
      this.emit('closed');
    }
  }

  return {
    BrowserWindow: MockBrowserWindow,
    nativeImage: { createFromPath: vi.fn(() => ({})) },
    screen: { getDisplayMatching: vi.fn(() => ({ workArea: MOCK_WORK_AREA })) },
  };
});

import { PopOutWindowManager } from '../../src/main/pop-out/pop-out-window-manager';
import { POP_OUT_SURFACES, resolveSurfaceTitle } from '../../src/shared/pop-out';
import { cascadePopOutPosition } from '../../src/main/pop-out/cascade';

/** Shape of the mocked BrowserWindow beyond the real Electron interface, so
 *  tests can inspect the constructor options and the position/maximize spies
 *  without importing the mock class itself. */
interface MockBrowserWindowLike {
  options: Record<string, unknown>;
  setPosition: ReturnType<typeof vi.fn>;
  maximize: ReturnType<typeof vi.fn>;
  getBounds: () => { x: number; y: number; width: number; height: number };
  emit: (event: string, ...args: unknown[]) => boolean;
}

function asMockWindow(win: unknown): MockBrowserWindowLike {
  return win as unknown as MockBrowserWindowLike;
}

function makeChangesFileParams(overrides: Partial<PopOutChangesFileParams> = {}): PopOutChangesFileParams {
  return {
    taskId: 'task-1',
    projectId: 'project-1',
    filePath: 'src/component.tsx',
    projectPath: 'C:\\Users\\dev\\repo',
    baseBranch: 'main',
    status: 'M',
    binary: false,
    taskDisplayId: 1,
    taskTitle: 'Sample task',
    ...overrides,
  };
}

describe('PopOutWindowManager.open()', () => {
  let manager: PopOutWindowManager;

  beforeEach(() => {
    vi.clearAllMocks();
    mockResolvePopOutBounds.mockReturnValue(null);
    manager = new PopOutWindowManager();
    const openContext: Parameters<typeof manager.configure>[0] = {
      devServerUrl: null,
      viteName: 'main_window',
      preloadPath: '/mock/preload.js',
      onOpenSetChanged: vi.fn(),
      getConfigManager: vi.fn(),
    } as unknown as Parameters<typeof manager.configure>[0];
    manager.configure(openContext);
  });

  it('returns null at the maxInstances cap for "changes-file" (the 9th open), while every below-cap open returns a window', () => {
    expect(POP_OUT_SURFACES['changes-file'].maxInstances).toBe(8);

    const openedWindows = [];
    for (let fileIndex = 0; fileIndex < 8; fileIndex += 1) {
      const params = makeChangesFileParams({ filePath: `src/file-${fileIndex}.tsx` });
      const win = manager.open('changes-file', params);
      expect(win, `open #${fileIndex + 1} (below cap) should return a window`).not.toBeNull();
      openedWindows.push(win);
    }

    const ninthParams = makeChangesFileParams({ filePath: 'src/file-8.tsx' });
    const ninthWindow = manager.open('changes-file', ninthParams);
    expect(ninthWindow).toBeNull();
  });

  it('applies the cascade offset via setPosition for the 2nd window of a kind, but not for the 1st', () => {
    const firstParams = makeChangesFileParams({ filePath: 'src/first.tsx' });
    const firstWindow = asMockWindow(manager.open('changes-file', firstParams));
    expect(firstWindow.setPosition).not.toHaveBeenCalled();

    const secondParams = makeChangesFileParams({ filePath: 'src/second.tsx' });
    const secondWindow = asMockWindow(manager.open('changes-file', secondParams));

    const expectedPosition = cascadePopOutPosition(
      { ...MOCK_DEFAULT_POSITION, width: 900, height: 700 },
      1,
      MOCK_WORK_AREA,
    );
    expect(secondWindow.setPosition).toHaveBeenCalledWith(expectedPosition.x, expectedPosition.y);
  });

  it('maximizes on reveal only when there is no saved bounds (openMaximized kind)', () => {
    expect(POP_OUT_SURFACES['changes-file'].openMaximized).toBe(true);

    mockResolvePopOutBounds.mockReturnValue(null);
    const noSavedBoundsParams = makeChangesFileParams({ filePath: 'src/no-saved-bounds.tsx' });
    const noSavedBoundsWindow = asMockWindow(manager.open('changes-file', noSavedBoundsParams));
    noSavedBoundsWindow.emit('ready-to-show');
    expect(noSavedBoundsWindow.maximize).toHaveBeenCalledTimes(1);
  });

  it('does not maximize on reveal when saved bounds exist and are not maximized', () => {
    mockResolvePopOutBounds.mockReturnValue({ x: 10, y: 10, width: 900, height: 700, maximized: false });
    const savedBoundsParams = makeChangesFileParams({ filePath: 'src/saved-bounds.tsx' });
    const savedBoundsWindow = asMockWindow(manager.open('changes-file', savedBoundsParams));
    savedBoundsWindow.emit('ready-to-show');
    expect(savedBoundsWindow.maximize).not.toHaveBeenCalled();
  });

  it('sets the BrowserWindow title to resolveSurfaceTitle(meta, params)', () => {
    const params = makeChangesFileParams({ filePath: 'src/titled.tsx', taskDisplayId: 42, taskTitle: 'Fix the thing' });
    const win = asMockWindow(manager.open('changes-file', params));

    const expectedTitle = resolveSurfaceTitle(POP_OUT_SURFACES['changes-file'], params);
    expect(win.options.title).toBe(expectedTitle);
  });

  it('throws when opening "changes-file" without a string filePath', () => {
    const paramsWithoutFilePath = {
      taskId: 'task-1',
      projectId: 'project-1',
    } as unknown as PopOutChangesFileParams;

    // Matches the guard's own error text, not just any throw - resolveTitle's
    // `filePath.split('/')` would ALSO throw (a TypeError on undefined) if the
    // dedicated guard were removed, so a bare `.toThrow()` would pass either
    // way and prove nothing about the guard itself.
    expect(() => manager.open('changes-file', paramsWithoutFilePath)).toThrow(/requires a filePath param/);
  });
});
