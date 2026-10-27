/**
 * Unit tests for PopOutWindowManager.open() (src/main/pop-out/pop-out-window-manager.ts) -
 * the only other place besides createWindow() allowed to construct a real OS BrowserWindow
 * (see .claude/rules/pop-out-surface-registry.md). Electron's BrowserWindow / nativeImage /
 * screen, and the window-utils bounds/icon helpers, are mocked so this suite is pure Node.
 * POP_OUT_SURFACES, resolveSurfaceTitle, and cascadePopOutPosition are the REAL,
 * already-unit-tested pure modules (see pop-out-cascade.test.ts), so these tests pin only
 * the wiring between them and the constructed window, not their own math.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PopOutChangesFileParams } from '../../src/shared/pop-out';

// vi.mock() calls are hoisted above every other statement in this file, so any
// outer variable a factory references must be declared through vi.hoisted() -
// otherwise the factory would run before its own `const` initializer.
const { mockResolveBackgroundColor, mockResolveIconPath, mockResolveRendererIndexPath, mockResolvePopOutBounds, mockSavePopOutBounds, mockTrackFeatureUsed, mockIsErrorReportingActive } = vi.hoisted(() => ({
  mockResolveBackgroundColor: vi.fn(() => '#18181b'),
  mockResolveIconPath: vi.fn(() => '/mock/icon.png'),
  mockResolveRendererIndexPath: vi.fn(() => '/mock/renderer/index.html'),
  mockResolvePopOutBounds: vi.fn(
    (): { x: number; y: number; width: number; height: number; maximized: boolean } | null => null,
  ),
  mockSavePopOutBounds: vi.fn(),
  mockTrackFeatureUsed: vi.fn(),
  mockIsErrorReportingActive: vi.fn(() => false),
}));

vi.mock('../../src/main/window-utils', () => ({
  resolveBackgroundColor: mockResolveBackgroundColor,
  resolveIconPath: mockResolveIconPath,
  resolveRendererIndexPath: mockResolveRendererIndexPath,
  resolvePopOutBounds: mockResolvePopOutBounds,
  savePopOutBounds: mockSavePopOutBounds,
}));
vi.mock('../../src/main/analytics/usage', () => ({
  trackFeatureUsed: mockTrackFeatureUsed,
}));
vi.mock('../../src/main/analytics/error-reporting', () => ({
  isErrorReportingActive: mockIsErrorReportingActive,
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
    showInactive = vi.fn();
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
import { POP_OUT_SURFACES, POPOUT_ARG_PREFIX, resolveSurfaceTitle } from '../../src/shared/pop-out';
import { cascadePopOutPosition } from '../../src/main/pop-out/cascade';
import { initMainI18n } from '../../src/main/i18n/main-i18n';
import { readLocaleArgument } from '../../src/shared/i18n/locales';

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
    mockIsErrorReportingActive.mockReturnValue(false);
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

  /**
   * A project-scoped surface takes a project and no task. Neither the task nor
   * the global check catches a bad one: params with no project id pass the
   * global check, and params naming a task pass as a task's.
   */
  describe('the project-scoped "command-terminal" surface', () => {
    it('opens one window per project, titled by the project name', () => {
      const win = asMockWindow(manager.open('command-terminal', { projectId: 'project-1', projectName: 'Kangentic' }));

      expect(win.options.title).toBe('Command Terminal - Kangentic');
      expect(manager.open('command-terminal', { projectId: 'project-1', projectName: 'Renamed' })).toBe(win);
      expect(manager.listOpenKeys()).toEqual(['command-terminal:project-1']);
    });

    it.each([
      ['no project id', { projectName: 'Kangentic' }],
      ['an empty project id', { projectId: '', projectName: 'Kangentic' }],
      ['a task', { projectId: 'project-1', projectName: 'Kangentic', taskId: 'task-1' }],
      ['no params', {}],
    ])('throws for params with %s', (_case, params) => {
      expect(() => manager.open('command-terminal', params as never)).toThrow(/requires \{ projectId, projectName \}/);
    });
  });

  /**
   * `--kangentic-error-reporting` is how the renderer's Sentry.init() call
   * agrees with main's single Sentry decision (mirrors createWindow() in
   * index.ts). A pop-out window that omits it while error reporting is
   * active would silently ship with no renderer Sentry.
   */
  describe('renderer boot flags (additionalArguments)', () => {
    function additionalArgumentsOf(win: unknown): string[] {
      const options = asMockWindow(win).options as { webPreferences?: { additionalArguments?: string[] } };
      return options.webPreferences?.additionalArguments ?? [];
    }

    it('includes --kangentic-error-reporting when Sentry is active, alongside the descriptor arg', () => {
      mockIsErrorReportingActive.mockReturnValue(true);
      const params = makeChangesFileParams({ filePath: 'src/error-reporting-on.tsx' });
      const win = manager.open('changes-file', params);

      const args = additionalArgumentsOf(win);
      expect(args).toContain('--kangentic-error-reporting');
      // The flag must not clobber the existing descriptor argument the pop-out
      // renderer reads its kind/params from.
      expect(args.some((arg) => arg.startsWith(POPOUT_ARG_PREFIX))).toBe(true);
    });

    it('omits the flag when Sentry did not initialize', () => {
      mockIsErrorReportingActive.mockReturnValue(false);
      const params = makeChangesFileParams({ filePath: 'src/error-reporting-off.tsx' });
      const win = manager.open('changes-file', params);

      const args = additionalArgumentsOf(win);
      expect(args).not.toContain('--kangentic-error-reporting');
      expect(args.some((arg) => arg.startsWith(POPOUT_ARG_PREFIX))).toBe(true);
    });

    /**
     * `--kangentic-locale=<code>` is how preload hands the session's display
     * language to the renderer before its first render (mirrors createWindow()
     * in index.ts, whose own argument is pinned in
     * gpu-escalation-report-wiring.test.ts). A pop-out that omits it boots in
     * English while the rest of the session is translated.
     */
    describe('the session language (localeArgument)', () => {
      const temporaryDirectories: string[] = [];

      function catalogDirectory(locales: readonly string[]): string {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-pop-out-i18n-'));
        temporaryDirectories.push(directory);
        for (const locale of locales) {
          fs.writeFileSync(path.join(directory, `${locale}.json`), JSON.stringify({ messages: {} }));
        }
        return directory;
      }

      afterEach(() => {
        // Main's translator is module state: put English back for the rest of the file.
        initMainI18n({ displayLanguage: 'en', catalogDirectory: catalogDirectory([]) });
        for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
      });

      it("passes the session's locale on the command line, where preload reads it back", () => {
        initMainI18n({
          displayLanguage: 'zh-CN',
          shippedLocales: ['en', 'zh-CN'],
          catalogDirectory: catalogDirectory(['en', 'zh-CN']),
        });
        const args = additionalArgumentsOf(manager.open('changes-file', makeChangesFileParams({ filePath: 'src/locale.tsx' })));

        expect(args).toContain('--kangentic-locale=zh-CN');
        expect(readLocaleArgument(args)).toBe('zh-CN');
        // The locale must not displace the descriptor the pop-out renderer reads its kind and params from.
        expect(args.some((arg) => arg.startsWith(POPOUT_ARG_PREFIX))).toBe(true);
      });
    });
  });

  /**
   * `trackFeatureUsed('popout_window')` is the adoption signal added
   * alongside this manager. It must fire on a genuine new-window creation
   * only, never on the focus-existing or cap-blocked early returns above it.
   */
  describe('adoption signal (trackFeatureUsed)', () => {
    it('fires popout_window on a genuine new-window creation', () => {
      const params = makeChangesFileParams({ filePath: 'src/adoption.tsx' });
      manager.open('changes-file', params);
      expect(mockTrackFeatureUsed).toHaveBeenCalledWith('popout_window');
    });

    it('does NOT re-fire when focusing an already-open window of the same key', () => {
      const params = makeChangesFileParams({ filePath: 'src/adoption-refocus.tsx' });
      manager.open('changes-file', params);
      mockTrackFeatureUsed.mockClear();

      manager.open('changes-file', params); // same key -> focuses the existing window
      expect(mockTrackFeatureUsed).not.toHaveBeenCalled();
    });

    it('does NOT fire when the maxInstances cap blocks a new window', () => {
      for (let fileIndex = 0; fileIndex < 8; fileIndex += 1) {
        manager.open('changes-file', makeChangesFileParams({ filePath: `src/cap-${fileIndex}.tsx` }));
      }
      mockTrackFeatureUsed.mockClear();

      const blocked = manager.open('changes-file', makeChangesFileParams({ filePath: 'src/cap-9th.tsx' }));
      expect(blocked).toBeNull();
      expect(mockTrackFeatureUsed).not.toHaveBeenCalled();
    });
  });
});

/** Shared setup for the sections below - identical to the outer describe's
 *  own beforeEach, duplicated because these are sibling top-level describes
 *  rather than nested under 'PopOutWindowManager.open()'. */
function createConfiguredManager(): PopOutWindowManager {
  const manager = new PopOutWindowManager();
  const openContext: Parameters<typeof manager.configure>[0] = {
    devServerUrl: null,
    viteName: 'main_window',
    preloadPath: '/mock/preload.js',
    onOpenSetChanged: vi.fn(),
    getConfigManager: vi.fn(),
  } as unknown as Parameters<typeof manager.configure>[0];
  manager.configure(openContext);
  return manager;
}

/**
 * `open(kind, params, { focus: false })` - the agent-initiated open path (see
 * .claude/rules/agent-driven-focus.md: "A window open never moves focus.").
 * `showInactive()` must be used instead of `show()` + `focus()` on reveal, and
 * re-opening an ALREADY-open instance with `focus: false` must not call
 * `.focus()` either. Both only exercised, before this branch, through the
 * mocked `popOutWindowManager` at call sites (browser-pane-detach.test.ts,
 * browser-viewport-override.test.ts); this pins the real implementation.
 */
describe('PopOutWindowManager.open() - focus option', () => {
  let manager: PopOutWindowManager;

  beforeEach(() => {
    vi.clearAllMocks();
    mockResolvePopOutBounds.mockReturnValue(null);
    mockIsErrorReportingActive.mockReturnValue(false);
    manager = createConfiguredManager();
  });

  it('showInactive()s a NEW window on reveal, and never calls show()/focus(), when focus is false', () => {
    const params = makeChangesFileParams({ filePath: 'src/agent-open.tsx' });
    const win = asMockWindow(manager.open('changes-file', params, { focus: false }));
    win.emit('ready-to-show');

    const mockWin = win as unknown as { showInactive: ReturnType<typeof vi.fn>; show: ReturnType<typeof vi.fn>; focus: ReturnType<typeof vi.fn> };
    expect(mockWin.showInactive).toHaveBeenCalledTimes(1);
    expect(mockWin.show).not.toHaveBeenCalled();
    expect(mockWin.focus).not.toHaveBeenCalled();
  });

  it('show()s and focus()s a NEW window on reveal by default (focus omitted)', () => {
    const params = makeChangesFileParams({ filePath: 'src/user-open.tsx' });
    const win = asMockWindow(manager.open('changes-file', params));
    win.emit('ready-to-show');

    const mockWin = win as unknown as { showInactive: ReturnType<typeof vi.fn>; show: ReturnType<typeof vi.fn>; focus: ReturnType<typeof vi.fn> };
    expect(mockWin.show).toHaveBeenCalledTimes(1);
    expect(mockWin.focus).toHaveBeenCalledTimes(1);
    expect(mockWin.showInactive).not.toHaveBeenCalled();
  });

  it('does not call focus() when re-opening an EXISTING window with focus: false', () => {
    const params = makeChangesFileParams({ filePath: 'src/existing.tsx' });
    const win = asMockWindow(manager.open('changes-file', params));
    win.emit('ready-to-show');
    (win as unknown as { focus: ReturnType<typeof vi.fn> }).focus.mockClear();

    const reopened = manager.open('changes-file', params, { focus: false });
    expect(reopened).toBe(win as unknown as ReturnType<typeof manager.open>);
    expect((win as unknown as { focus: ReturnType<typeof vi.fn> }).focus).not.toHaveBeenCalled();
  });

  it('still calls focus() when re-opening an EXISTING window by default', () => {
    const params = makeChangesFileParams({ filePath: 'src/existing-default.tsx' });
    const win = asMockWindow(manager.open('changes-file', params));
    win.emit('ready-to-show');
    (win as unknown as { focus: ReturnType<typeof vi.fn> }).focus.mockClear();

    manager.open('changes-file', params);
    expect((win as unknown as { focus: ReturnType<typeof vi.fn> }).focus).toHaveBeenCalledTimes(1);
  });
});

/**
 * `windowFor()` - the read-only lookup a caller uses to reach the live OS
 * window for a pop-out instance (used by the viewport-override resize path).
 */
describe('PopOutWindowManager.windowFor()', () => {
  let manager: PopOutWindowManager;

  beforeEach(() => {
    vi.clearAllMocks();
    mockResolvePopOutBounds.mockReturnValue(null);
    mockIsErrorReportingActive.mockReturnValue(false);
    manager = createConfiguredManager();
  });

  it('returns the tracked window for an open instance', () => {
    const params = makeChangesFileParams({ filePath: 'src/window-for.tsx' });
    const win = manager.open('changes-file', params);

    expect(manager.windowFor('changes-file', params)).toBe(win);
  });

  it('returns null for an instance that was never opened', () => {
    const params = makeChangesFileParams({ filePath: 'src/never-opened.tsx' });
    expect(manager.windowFor('changes-file', params)).toBeNull();
  });

  it('returns null once the window has been closed', () => {
    const params = makeChangesFileParams({ filePath: 'src/closed.tsx' });
    const win = asMockWindow(manager.open('changes-file', params));
    win.emit('closed');

    expect(manager.windowFor('changes-file', params)).toBeNull();
  });
});

/**
 * `closeForTask()` - closes a task's windows when its work ends (Done, a To Do
 * reset, a delete). Must close every task-scoped kind for exactly that task in
 * exactly that project, through `close()`, so each close looks like a user's:
 * the open-set push carries the survivors and a pending bounds save is dropped.
 */
describe('PopOutWindowManager.closeForTask()', () => {
  let manager: PopOutWindowManager;
  let onOpenSetChanged: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockResolvePopOutBounds.mockReturnValue(null);
    mockIsErrorReportingActive.mockReturnValue(false);
    manager = new PopOutWindowManager();
    onOpenSetChanged = vi.fn();
    manager.configure({
      devServerUrl: null,
      viteName: 'main_window',
      preloadPath: '/mock/preload.js',
      onOpenSetChanged,
      getConfigManager: vi.fn(),
    } as unknown as Parameters<typeof manager.configure>[0]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const taskA = { projectId: 'project-1', taskId: 'task-1' };

  function openMixedWindows() {
    const taskAWindows = [
      manager.open('browser', taskA),
      manager.open('changes', taskA),
      manager.open('changes-file', makeChangesFileParams({ filePath: 'src/first.tsx' })),
      manager.open('changes-file', makeChangesFileParams({ filePath: 'src/second.tsx' })),
    ];
    const survivors = [
      manager.open('browser', { projectId: 'project-1', taskId: 'task-2' }),
      manager.open('stats', {}),
      // Same task id under another project: a different task, never closed.
      manager.open('browser', { projectId: 'project-2', taskId: 'task-1' }),
    ];
    return { taskAWindows, survivors };
  }

  function closeSpyOf(win: unknown): ReturnType<typeof vi.spyOn> {
    return vi.spyOn(win as { close: () => void }, 'close');
  }

  it('closes every task-scoped window of the task through close(), and nothing else', () => {
    const { taskAWindows, survivors } = openMixedWindows();
    const taskASpies = taskAWindows.map(closeSpyOf);
    const survivorSpies = survivors.map(closeSpyOf);
    const survivorKeys = [
      'browser:project-1:task-2',
      'stats',
      'browser:project-2:task-1',
    ];

    expect(manager.closeForTask(taskA)).toBe(4);

    for (const spy of taskASpies) expect(spy).toHaveBeenCalledTimes(1);
    for (const spy of survivorSpies) expect(spy).not.toHaveBeenCalled();
    expect(manager.listOpenKeys().sort()).toEqual([...survivorKeys].sort());
    // The renderer's popOut:changed comes from this callback: its last call is
    // the set the main window sees after the close.
    const lastOpenSet = onOpenSetChanged.mock.calls.at(-1)?.[0] as string[];
    expect([...lastOpenSet].sort()).toEqual([...survivorKeys].sort());
  });

  it('skips a window that is already destroyed, and counts only the windows it closed', () => {
    const { taskAWindows, survivors } = openMixedWindows();
    const taskASpies = taskAWindows.map(closeSpyOf);
    const survivorSpies = survivors.map(closeSpyOf);
    // Destroyed but still tracked: Electron has torn the window down and the
    // manager's 'closed' handler has not run yet. The mock's own destroy() would
    // emit 'closed' and untrack the window, which never reaches the skip.
    const destroyedIndex = 1;
    vi.spyOn(taskAWindows[destroyedIndex] as unknown as { isDestroyed: () => boolean }, 'isDestroyed').mockReturnValue(true);

    expect(manager.closeForTask(taskA)).toBe(taskAWindows.length - 1);

    taskASpies.forEach((spy, index) => {
      expect(spy).toHaveBeenCalledTimes(index === destroyedIndex ? 0 : 1);
    });
    for (const spy of survivorSpies) expect(spy).not.toHaveBeenCalled();
  });

  it('drops a pending bounds save, as a user close does', () => {
    const browserWindow = asMockWindow(manager.open('browser', taskA));
    browserWindow.emit('resize');

    manager.closeForTask(taskA);
    vi.advanceTimersByTime(600); // past BOUNDS_SAVE_DEBOUNCE_MS (500ms)

    expect(mockSavePopOutBounds).not.toHaveBeenCalled();
  });

  it('returns 0 and closes nothing for a task with no windows', () => {
    const { taskAWindows, survivors } = openMixedWindows();
    const survivorSpies = survivors.map(closeSpyOf);

    expect(manager.closeForTask({ projectId: 'project-1', taskId: 'task-9' })).toBe(0);
    for (const spy of survivorSpies) expect(spy).not.toHaveBeenCalled();
    expect(manager.listOpenKeys()).toHaveLength(taskAWindows.length + survivors.length);
  });
});

/**
 * `suppressBoundsSave()` - keeps an AGENT-driven resize (viewport emulation
 * on a detached Browser pane) out of the user's saved pop-out bounds, which
 * are keyed by KIND, not by instance: an agent size would overwrite the size
 * every task's window opens at, invisibly. See the constant's own doc
 * comment and `.claude/rules/browser-automation-driver.md`.
 *
 * Only the CONSUMER side (viewport-override.ts calling this as a mocked
 * dependency) had coverage before this branch
 * (tests/unit/browser-viewport-override.test.ts:872). Nothing exercised the
 * real refcounting / settle-window arithmetic inside the manager itself.
 */
describe('PopOutWindowManager.suppressBoundsSave()', () => {
  let manager: PopOutWindowManager;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockResolvePopOutBounds.mockReturnValue(null);
    mockIsErrorReportingActive.mockReturnValue(false);
    manager = createConfiguredManager();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('a resize while suppression is HELD never reaches savePopOutBounds, even after the debounce elapses', () => {
    const params = makeChangesFileParams({ filePath: 'src/suppressed.tsx' });
    const win = asMockWindow(manager.open('changes-file', params));
    const release = manager.suppressBoundsSave('changes-file', params);

    win.emit('resize');
    vi.advanceTimersByTime(600); // past BOUNDS_SAVE_DEBOUNCE_MS (500ms)

    expect(mockSavePopOutBounds).not.toHaveBeenCalled();
    release();
  });

  it('a resize scheduled BEFORE release, whose debounce fires AFTER release, is still suppressed (the settle margin)', () => {
    // This is the case the settle margin exists for: the timer armed by the
    // LAST agent resize fires after suppressBoundsSave's disposer has
    // already run, and would otherwise persist exactly the size this exists
    // to keep out.
    const params = makeChangesFileParams({ filePath: 'src/settle-margin.tsx' });
    const win = asMockWindow(manager.open('changes-file', params));
    const release = manager.suppressBoundsSave('changes-file', params);

    win.emit('resize');
    release(); // agent's drive body has returned; debounce timer is still pending
    vi.advanceTimersByTime(600); // past the 500ms debounce alone

    expect(mockSavePopOutBounds).not.toHaveBeenCalled();
  });

  it('a resize scheduled well AFTER release (past the settle margin) saves normally', () => {
    const params = makeChangesFileParams({ filePath: 'src/post-settle.tsx' });
    const win = asMockWindow(manager.open('changes-file', params));
    const release = manager.suppressBoundsSave('changes-file', params);
    release();

    // Past BOUNDS_SAVE_DEBOUNCE_MS (500) + BOUNDS_SAVE_SETTLE_MS (250) before
    // the NEXT resize fires - a real user drag well after the agent finished.
    vi.advanceTimersByTime(800);
    win.emit('resize');
    vi.advanceTimersByTime(600);

    expect(mockSavePopOutBounds).toHaveBeenCalledTimes(1);
  });

  it('refcounts overlapping holds: releasing ONE of two still suppresses', () => {
    // Advances past releaseFirst's OWN settle window before resizing, so this
    // isolates the depth refcount from the settle-window check above it - a
    // release that wrongly zeroed the depth (instead of decrementing it)
    // would otherwise still read as suppressed by the settle window alone
    // and this test would pass for the wrong reason.
    const params = makeChangesFileParams({ filePath: 'src/refcount.tsx' });
    const win = asMockWindow(manager.open('changes-file', params));
    const releaseFirst = manager.suppressBoundsSave('changes-file', params);
    const releaseSecond = manager.suppressBoundsSave('changes-file', params);

    releaseFirst();
    vi.advanceTimersByTime(800); // past releaseFirst's own settle window (750ms)
    win.emit('resize');
    vi.advanceTimersByTime(600); // past the debounce

    expect(mockSavePopOutBounds).not.toHaveBeenCalled();
    releaseSecond();
  });

  it('a plain resize with no suppression in effect saves normally (baseline)', () => {
    const params = makeChangesFileParams({ filePath: 'src/baseline.tsx' });
    const win = asMockWindow(manager.open('changes-file', params));

    win.emit('resize');
    vi.advanceTimersByTime(600);

    expect(mockSavePopOutBounds).toHaveBeenCalledTimes(1);
  });

  it('the disposer is idempotent: calling it twice does not under-run the refcount below zero', () => {
    const params = makeChangesFileParams({ filePath: 'src/idempotent-release.tsx' });
    const win = asMockWindow(manager.open('changes-file', params));
    const release = manager.suppressBoundsSave('changes-file', params);

    release();
    release(); // must not push depth to -1 and thereby require a second acquire to re-suppress
    vi.advanceTimersByTime(800); // past the settle margin from the first release

    win.emit('resize');
    vi.advanceTimersByTime(600);

    expect(mockSavePopOutBounds).toHaveBeenCalledTimes(1);
  });

  it('returns a no-op disposer for an instance that is not currently open', () => {
    const params = makeChangesFileParams({ filePath: 'src/not-open.tsx' });
    expect(() => manager.suppressBoundsSave('changes-file', params)()).not.toThrow();
  });
});
