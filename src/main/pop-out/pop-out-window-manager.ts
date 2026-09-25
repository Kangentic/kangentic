import { BrowserWindow, nativeImage, screen } from 'electron';
import type { ConfigManager } from '../config/config-manager';
import { resolveBackgroundColor, resolveIconPath, resolveRendererIndexPath, resolvePopOutBounds, savePopOutBounds } from '../window-utils';
import { POP_OUT_SURFACES, POPOUT_ARG_PREFIX, popOutInstanceKey, resolveSurfaceTitle } from '../../shared/pop-out';
import type { PopOutChangesFileParams, PopOutDescriptor, PopOutKind, PopOutParams, PopOutTaskParams } from '../../shared/pop-out';
import { cascadePopOutPosition } from './cascade';
import { trackFeatureUsed } from '../analytics/usage';
import { isErrorReportingActive } from '../analytics/error-reporting';

const BOUNDS_SAVE_DEBOUNCE_MS = 500;

/** Extra grace past the debounce before a bounds save counts as the user's
 *  again, once an agent resize has finished. See `suppressBoundsSave`. */
const BOUNDS_SAVE_SETTLE_MS = 250;

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
  /** How many agent-driven resizes are in flight against this window. */
  agentResizeDepth: number;
  /** Epoch ms until which a bounds save is still attributed to an agent
   *  resize that has just finished. See `suppressBoundsSave`. */
  agentResizeSettledUntil: number;
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

  /** Open a surface's pop-out window, or focus it if already open. Returns null (no
   *  window, no throw) when the kind declares `maxInstances` and that many windows of
   *  it are already live - the IPC handler surfaces that as `false` so the renderer
   *  can tell the user. Throws on an unknown kind, a scope/params mismatch, or if
   *  called before configure().
   *
   *  `options.focus: false` shows the window without raising it or taking the
   *  keyboard. That is required, not cosmetic, for an AGENT-initiated open: an
   *  agent action must never move the user's focus, and a window appearing over
   *  what someone is typing into is the loudest possible version of that. See
   *  `.claude/rules/agent-driven-focus.md`. */
  open<K extends PopOutKind>(
    kind: K,
    params: PopOutParams<K>,
    options: { focus?: boolean } = {},
  ): BrowserWindow | null {
    const takeFocus = options.focus !== false;
    const key = popOutInstanceKey(kind, params);
    const existing = this.windows.get(key);
    if (existing && !existing.window.isDestroyed()) {
      if (existing.window.isMinimized()) existing.window.restore();
      if (takeFocus) existing.window.focus();
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
    if (kind === 'changes-file' && typeof (params as PopOutChangesFileParams).filePath !== 'string') {
      throw new Error(`Pop-out surface "${kind}" requires a filePath param`);
    }
    if (!this.openContext) {
      throw new Error('PopOutWindowManager.open() called before configure()');
    }
    const openContext = this.openContext;

    // Kind-wide window cap, enforced here because this is the only place that can
    // see every live window (a pop-out renderer never receives POPOUT_CHANGED, so
    // a renderer-side count cannot hold). Focusing an existing instance above
    // never counts against the cap.
    const liveOfKind = [...this.windows.values()]
      .filter((tracked) => tracked.kind === kind && !tracked.window.isDestroyed()).length;
    if (meta.maxInstances !== undefined && liveOfKind >= meta.maxInstances) return null;

    const savedBounds = resolvePopOutBounds(kind);
    const iconImage = nativeImage.createFromPath(resolveIconPath());
    const descriptor: PopOutDescriptor<K> = { kind, params };
    const encodedDescriptor = Buffer.from(JSON.stringify(descriptor), 'utf-8').toString('base64');

    const win = new BrowserWindow({
      icon: iconImage,
      ...(savedBounds ?? meta.defaultBounds),
      minWidth: meta.minSize.width,
      minHeight: meta.minSize.height,
      title: resolveSurfaceTitle(meta, params),
      backgroundColor: resolveBackgroundColor(),
      show: false,
      titleBarStyle: 'hidden',
      ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 12, y: 12 } } : {}),
      webPreferences: {
        preload: openContext.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: meta.needsWebview,
        additionalArguments: [
          `${POPOUT_ARG_PREFIX}${encodedDescriptor}`,
          // Mirrors createWindow() in index.ts: preload derives
          // analytics.errorReportingEnabled per-window from this flag, so a
          // window factory that omits it silently disables renderer Sentry
          // for every window it creates.
          ...(isErrorReportingActive() ? ['--kangentic-error-reporting'] : []),
        ],
      },
    });

    // Windows/Linux taskbar icon: the constructor `icon:` option alone is not always
    // sufficient (createWindow() in index.ts sets it explicitly for the same reason).
    // macOS uses the app bundle / dock icon, so it is skipped there.
    if (process.platform !== 'darwin') win.setIcon(iconImage);

    // Adoption signal on genuine creation only (the focus/cap early returns
    // above never reach here); trackFeatureUsed dedups to once per day.
    trackFeatureUsed('popout_window');

    // Saved bounds are keyed by KIND, so every additional live window of this kind
    // would restore exactly stacked on the first. Cascade it down-right instead.
    // Done post-construction (the window is still `show: false`, so no flicker)
    // because meta.defaultBounds carries no x/y - Electron centers the window,
    // and getBounds() is the first place the resolved position exists.
    if (liveOfKind > 0) {
      const currentBounds = win.getBounds();
      const workArea = screen.getDisplayMatching(currentBounds).workArea;
      const cascaded = cascadePopOutPosition(currentBounds, liveOfKind, workArea);
      win.setPosition(cascaded.x, cascaded.y);
    }

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
      // Saved state wins; with none saved yet, an openMaximized kind starts
      // maximized out of the box (un-maximize restores the defaultBounds float,
      // cascade offset included - the constructor bounds are the restore rect).
      if (savedBounds ? savedBounds.maximized : meta.openMaximized) win.maximize();
      // `showInactive` rather than `show` for an agent-initiated open: it puts
      // the window on screen without raising it over what the user is doing or
      // moving the keyboard into it.
      if (takeFocus) {
        win.show();
        win.focus();
      } else {
        win.showInactive();
      }
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

    const tracked: TrackedPopOut = {
      kind,
      params,
      window: win,
      boundsTimer: null,
      agentResizeDepth: 0,
      agentResizeSettledUntil: 0,
    };
    const scheduleBoundsSave = () => {
      if (tracked.boundsTimer) clearTimeout(tracked.boundsTimer);
      tracked.boundsTimer = setTimeout(() => {
        tracked.boundsTimer = null;
        // Saved bounds are keyed by pop-out KIND, not by instance, so a size an
        // AGENT asked for would overwrite the size the USER chose, for every
        // task, invisibly. An agent viewport is a transient testing condition;
        // only a human dragging the frame is a preference. See
        // `suppressBoundsSave`.
        if (tracked.agentResizeDepth > 0 || Date.now() < tracked.agentResizeSettledUntil) return;
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

  /** The live window for one instance, or null. Lets a caller that must act on
   *  the OS window itself (resizing a detached Browser pane to a requested
   *  viewport) reach it without a second `new BrowserWindow` site or a
   *  `fromWebContents` walk that can resolve the wrong window. */
  windowFor<K extends PopOutKind>(kind: K, params: PopOutParams<K>): BrowserWindow | null {
    const tracked = this.windows.get(popOutInstanceKey(kind, params));
    if (!tracked || tracked.window.isDestroyed()) return null;
    return tracked.window;
  }

  /**
   * Mark the resizes that happen until the returned disposer runs as
   * agent-driven, so they do not become the user's saved window size.
   *
   * The settle margin after the disposer matters as much as the flag: the save
   * is debounced, so the timer armed by the last agent resize fires AFTER the
   * operation is over and would otherwise persist exactly the size this is
   * meant to keep out. A later user drag re-arms the timer past the margin and
   * persists normally.
   */
  suppressBoundsSave<K extends PopOutKind>(kind: K, params: PopOutParams<K>): () => void {
    const tracked = this.windows.get(popOutInstanceKey(kind, params));
    if (!tracked) return () => {};
    tracked.agentResizeDepth += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      tracked.agentResizeDepth = Math.max(0, tracked.agentResizeDepth - 1);
      tracked.agentResizeSettledUntil = Date.now() + BOUNDS_SAVE_DEBOUNCE_MS + BOUNDS_SAVE_SETTLE_MS;
    };
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
