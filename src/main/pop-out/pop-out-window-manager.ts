import { BrowserWindow, nativeImage } from 'electron';
import type { ConfigManager } from '../config/config-manager';
import { resolveBackgroundColor, resolveIconPath, resolveRendererIndexPath, resolvePopOutBounds, savePopOutBounds } from '../window-utils';
import { POP_OUT_SURFACES, POPOUT_ARG_PREFIX, popOutInstanceKey } from '../../shared/pop-out';
import type { PopOutDescriptor, PopOutKind, PopOutParams, PopOutTaskParams } from '../../shared/pop-out';

const BOUNDS_SAVE_DEBOUNCE_MS = 500;

interface PopOutOpenContext {
  /** MAIN_WINDOW_VITE_DEV_SERVER_URL, or null in a production build. */
  devServerUrl: string | null;
  /** MAIN_WINDOW_VITE_NAME (the Vite build name used to resolve the packaged index.html). */
  viteName: string;
  /** Same preload script as the main window (path.join(__dirname, 'preload.js')). */
  preloadPath: string;
  /** Called whenever the set of open pop-out windows changes, so the caller can push
   *  POPOUT_CHANGED to the main window. Receives every currently-open instance key. */
  onOpenSetChanged: (openInstanceKeys: string[]) => void;
  /** Resolves the canonical, app-shared ConfigManager (the same instance every config:set
   *  handler writes through). Bounds persistence MUST use it, not a private instance: two
   *  ConfigManagers each cache the parsed config in memory and rewrite the whole blob on
   *  save(), so a private instance would clobber unrelated settings written meanwhile.
   *  Resolved lazily (called at save time) because the context is built after configure(). */
  getConfigManager: () => ConfigManager;
}

interface TrackedPopOut {
  kind: PopOutKind;
  params: PopOutParams;
  window: BrowserWindow;
  boundsTimer: ReturnType<typeof setTimeout> | null;
}

function isTaskParams(params: PopOutParams): params is PopOutTaskParams {
  return !!params && typeof params === 'object' && 'taskId' in params && 'projectId' in params;
}

/**
 * Opens, tracks, focuses, and closes OS-level pop-out BrowserWindows for detachable UI
 * surfaces (usage stats, git changes, the task Browser pane). This is the ONLY other
 * place in the app (besides createWindow() in src/main/index.ts) that constructs a
 * BrowserWindow - see .claude/rules/pop-out-surface-registry.md.
 *
 * A module singleton (mirroring browserPaneRegistry / the updater module) so it is
 * reachable from the broadcast helper and the synchronous shutdown path without
 * threading it through IpcContext.
 */
export class PopOutWindowManager {
  private readonly windows = new Map<string, TrackedPopOut>();
  private openContext: PopOutOpenContext | null = null;

  /** Called once from createWindow() after the Vite build constants and __dirname are
   *  in scope. Safe to call again (e.g. on macOS re-activate); simply replaces the context. */
  configure(openContext: PopOutOpenContext): void {
    this.openContext = openContext;
  }

  /** Open a surface's pop-out window, or focus it if already open. Throws on an unknown
   *  kind, a scope/params mismatch, or if called before configure(). */
  open<K extends PopOutKind>(kind: K, params: PopOutParams<K>): BrowserWindow {
    const key = popOutInstanceKey(kind, params);
    const existing = this.windows.get(key);
    if (existing && !existing.window.isDestroyed()) {
      if (existing.window.isMinimized()) existing.window.restore();
      existing.window.focus();
      return existing.window;
    }

    const meta = POP_OUT_SURFACES[kind];
    if (!meta) throw new Error(`No pop-out surface registered for kind "${kind}"`);
    if (meta.scope === 'task' && !isTaskParams(params)) {
      throw new Error(`Pop-out surface "${kind}" requires { taskId, projectId } params`);
    }
    if (meta.scope === 'global' && isTaskParams(params)) {
      throw new Error(`Pop-out surface "${kind}" is global and takes no params`);
    }
    if (!this.openContext) {
      throw new Error('PopOutWindowManager.open() called before configure()');
    }
    const openContext = this.openContext;

    const savedBounds = resolvePopOutBounds(kind);
    const iconImage = nativeImage.createFromPath(resolveIconPath());
    const descriptor: PopOutDescriptor<K> = { kind, params };
    const encodedDescriptor = Buffer.from(JSON.stringify(descriptor), 'utf-8').toString('base64');

    const win = new BrowserWindow({
      icon: iconImage,
      ...(savedBounds ?? meta.defaultBounds),
      minWidth: meta.minSize.width,
      minHeight: meta.minSize.height,
      title: meta.title,
      backgroundColor: resolveBackgroundColor(),
      show: false,
      titleBarStyle: 'hidden',
      ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 12, y: 12 } } : {}),
      webPreferences: {
        preload: openContext.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: meta.needsWebview,
        additionalArguments: [`${POPOUT_ARG_PREFIX}${encodedDescriptor}`],
      },
    });

    // Windows/Linux taskbar icon: the constructor `icon:` option alone is not always
    // sufficient (createWindow() in index.ts sets it explicitly for the same reason).
    // macOS uses the app bundle / dock icon, so it is skipped there.
    if (process.platform !== 'darwin') win.setIcon(iconImage);

    // Reveal the window exactly once. `ready-to-show` is the preferred (no-flash)
    // trigger, but a second BrowserWindow does not reliably emit it in every
    // Electron/dev-server setup - a window created with `show: false` whose
    // ready-to-show is missed would stay invisible forever (and focus()/restore()
    // cannot rescue a never-shown window). So we also reveal on load completion,
    // and even on load FAILURE (surfacing the error) so the window is never
    // created-but-invisible. `backgroundColor` above prevents a white flash if
    // did-finish-load wins the race before first paint.
    let hasShown = false;
    const reveal = () => {
      if (hasShown || win.isDestroyed()) return;
      hasShown = true;
      if (savedBounds?.maximized) win.maximize();
      win.show();
      win.focus();
    };
    win.once('ready-to-show', reveal);
    win.webContents.once('did-finish-load', reveal);
    win.webContents.once('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
      console.error(`[pop-out] ${kind} failed to load ${validatedURL}: ${errorCode} ${errorDescription}`);
      reveal();
    });

    if (openContext.devServerUrl) {
      win.loadURL(`${openContext.devServerUrl}#${kind}`);
    } else {
      win.loadFile(resolveRendererIndexPath(openContext.viteName), { hash: kind });
    }

    const tracked: TrackedPopOut = { kind, params, window: win, boundsTimer: null };
    const scheduleBoundsSave = () => {
      if (tracked.boundsTimer) clearTimeout(tracked.boundsTimer);
      tracked.boundsTimer = setTimeout(() => {
        tracked.boundsTimer = null;
        savePopOutBounds(kind, win, openContext.getConfigManager());
      }, BOUNDS_SAVE_DEBOUNCE_MS);
    };
    win.on('move', scheduleBoundsSave);
    win.on('resize', scheduleBoundsSave);

    win.on('closed', () => {
      if (tracked.boundsTimer) clearTimeout(tracked.boundsTimer);
      this.windows.delete(key);
      this.emitOpenSetChanged();
    });

    this.windows.set(key, tracked);
    this.emitOpenSetChanged();
    return win;
  }

  focus<K extends PopOutKind>(kind: K, params: PopOutParams<K>): void {
    const tracked = this.windows.get(popOutInstanceKey(kind, params));
    if (!tracked || tracked.window.isDestroyed()) return;
    if (tracked.window.isMinimized()) tracked.window.restore();
    tracked.window.focus();
  }

  close<K extends PopOutKind>(kind: K, params: PopOutParams<K>): void {
    const tracked = this.windows.get(popOutInstanceKey(kind, params));
    if (!tracked) return;
    if (tracked.boundsTimer) clearTimeout(tracked.boundsTimer);
    if (!tracked.window.isDestroyed()) tracked.window.close();
    // win.on('closed') above removes the map entry and emits the change.
  }

  has<K extends PopOutKind>(kind: K, params: PopOutParams<K>): boolean {
    const tracked = this.windows.get(popOutInstanceKey(kind, params));
    return !!tracked && !tracked.window.isDestroyed();
  }

  /** Instance keys of every currently-open (non-destroyed) pop-out window. */
  listOpenKeys(): string[] {
    const keys: string[] = [];
    for (const [key, tracked] of this.windows) {
      if (!tracked.window.isDestroyed()) keys.push(key);
    }
    return keys;
  }

  /** Live pop-out windows whose surface declared `channel` in its fan-out list. */
  windowsForChannel(channel: string): BrowserWindow[] {
    const result: BrowserWindow[] = [];
    for (const tracked of this.windows.values()) {
      if (tracked.window.isDestroyed()) continue;
      if (POP_OUT_SURFACES[tracked.kind]?.channels.includes(channel)) {
        result.push(tracked.window);
      }
    }
    return result;
  }

  /** Synchronous, idempotent teardown of every tracked pop-out window. Used on main
   *  window close and during the synchronous shutdown path - no await, per
   *  .claude/rules/synchronous-shutdown.md. Snapshots the map before iterating because
   *  destroy() fires 'closed' synchronously, which mutates this.windows mid-iteration. */
  destroyAll(): void {
    const tracked = [...this.windows.values()];
    for (const entry of tracked) {
      if (entry.boundsTimer) {
        clearTimeout(entry.boundsTimer);
        entry.boundsTimer = null;
      }
      if (!entry.window.isDestroyed()) entry.window.destroy();
    }
    this.windows.clear();
  }

  private emitOpenSetChanged(): void {
    this.openContext?.onOpenSetChanged(this.listOpenKeys());
  }
}

export const popOutWindowManager = new PopOutWindowManager();
