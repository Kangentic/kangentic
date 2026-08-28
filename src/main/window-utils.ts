import path from 'node:path';
import fs from 'node:fs';
import { app, screen, type BrowserWindow } from 'electron';
import { PATHS } from './config/paths';
import { THEME_BACKGROUNDS } from '../shared/types';
import type { AppConfig, ThemeMode } from '../shared/types';
import type { PopOutKind } from '../shared/pop-out';
import type { ConfigManager } from './config/config-manager';

/** Resolve the background color from the config file's theme setting. */
export function resolveBackgroundColor(): string {
  try {
    const raw = fs.readFileSync(PATHS.configFile, 'utf-8');
    const theme = (JSON.parse(raw) as { theme?: ThemeMode }).theme;
    if (theme && theme in THEME_BACKGROUNDS) {
      return THEME_BACKGROUNDS[theme];
    }
  } catch {
    // Config file missing or malformed - use default
  }
  return '#18181b';
}

/** Resolve the application icon path based on platform and packaging state. */
export function resolveIconPath(): string {
  const iconFilename = process.platform === 'win32' ? 'icon.ico' : 'icon.png';
  return app.isPackaged
    ? path.join(process.resourcesPath, iconFilename)
    : path.join(app.getAppPath(), 'node_modules', '@kangentic', 'branding', 'resources', 'desktop', iconFilename);
}

/** Resolve the renderer's built index.html for a given Vite build name (production
 *  loadFile path, no dev server). Prefers the esbuild layout (`./renderer/`); falls back
 *  to the legacy Forge layout (`../renderer/`) if the standalone path is missing (a stale
 *  `.vite/renderer/` dev-cache directory can survive a fresh `npm run build`). Shared by
 *  the main window and every pop-out window so both resolve identically. */
export function resolveRendererIndexPath(viteName: string): string {
  const standalonePath = path.join(__dirname, `renderer/${viteName}/index.html`);
  const legacyPath = path.join(__dirname, `../renderer/${viteName}/index.html`);
  return fs.existsSync(standalonePath) ? standalonePath : legacyPath;
}

/**
 * Compute the main window's OS/taskbar title.
 *
 * Pure: the caller resolves `appLabel` ("Kangentic (dev)" vs "Kangentic") from the
 * build-time `__KANGENTIC_DEV__` constant AT THE CALL SITE, not in here. Two reasons:
 * that identifier is an esbuild `define` and does not exist as a runtime global under
 * vitest; and, more load-bearingly, esbuild's dead-code elimination folds a direct
 * `__KANGENTIC_DEV__ ? 'Kangentic (dev)' : 'Kangentic'` reference to the `false` branch
 * and drops the "(dev)" string literal from the production bundle entirely - but only
 * at the reference site itself. Moving that ternary in here would make it read a plain
 * `boolean` parameter instead, which esbuild cannot fold across the module boundary, so
 * the literal would ship (dead, unreachable, but present) in every production build.
 * Keep the ternary inline at the call site in index.ts; this function only composes the
 * already-resolved label with the worktree/preview logic.
 *
 * `resolvePreviewTaskTitle` is a thunk so it is invoked only when a worktree is actually
 * detected, preserving the original call site's laziness (that resolver does a real, if
 * best-effort, DB lookup).
 *
 * Outside a worktree, the title is just `appLabel` - in production that already matches
 * what index.html's static <title> shows, so setTitle restates rather than changes that
 * case.
 *
 * Inside a worktree, a resolved preview task label (`#<id> - <title>`) wins outright with
 * NO `appLabel` prefix - Windows already groups the thumbnail under the Kangentic taskbar
 * group, so repeating the app name there only pushes the part that identifies the window
 * past the edge of the thumbnail. Otherwise it falls back to "<appLabel> - <folderLabel>",
 * where a purely-numeric worktree folder (the task's display_id) reads as "#<id>" instead
 * of a bare number, and a legacy `<slug>-<shortId>` folder is used verbatim.
 */
export function computeWindowTitle(
  appLabel: string,
  cwd: string | null,
  resolvePreviewTaskTitle: () => string | null,
): string {
  const worktreeMatch = cwd ? cwd.replace(/\\/g, '/').match(/\.kangentic\/worktrees\/([^/]+)/) : null;
  if (!worktreeMatch) return appLabel;
  const folderName = worktreeMatch[1];
  const folderLabel = /^\d+$/.test(folderName) ? `#${folderName}` : folderName;
  return resolvePreviewTaskTitle() ?? `${appLabel} - ${folderLabel}`;
}

/** Read saved window bounds from config, with screen-boundary validation. */
export function resolveWindowBounds(): { x: number; y: number; width: number; height: number; maximized: boolean } | null {
  try {
    const raw = fs.readFileSync(PATHS.configFile, 'utf-8');
    const config = JSON.parse(raw) as Partial<AppConfig>;
    if (!config.restoreWindowPosition || !config.windowBounds) return null;
    const { x, y, width, height } = config.windowBounds;
    if (width < 400 || height < 300) return null;
    // Verify the window overlaps at least one display (e.g. external monitor disconnected)
    const displays = screen.getAllDisplays();
    const overlapsDisplay = displays.some((display) => {
      const { x: displayX, y: displayY, width: displayWidth, height: displayHeight } = display.bounds;
      return x < displayX + displayWidth && x + width > displayX
        && y < displayY + displayHeight && y + height > displayY;
    });
    if (!overlapsDisplay) return null;
    return { x, y, width, height, maximized: config.windowMaximized ?? false };
  } catch {
    return null;
  }
}

/** Read saved bounds for a detached pop-out surface (keyed by kind), with the same
 *  screen-boundary validation as resolveWindowBounds (falls back to the surface's default
 *  bounds when the saved display no longer overlaps any connected display). */
export function resolvePopOutBounds(kind: PopOutKind): { x: number; y: number; width: number; height: number; maximized: boolean } | null {
  try {
    const raw = fs.readFileSync(PATHS.configFile, 'utf-8');
    const config = JSON.parse(raw) as Partial<AppConfig>;
    if (!config.restoreWindowPosition) return null;
    const saved = config.popOutBounds?.[kind];
    if (!saved) return null;
    const { x, y, width, height } = saved.bounds;
    if (width < 320 || height < 240) return null;
    const displays = screen.getAllDisplays();
    const overlapsDisplay = displays.some((display) => {
      const { x: displayX, y: displayY, width: displayWidth, height: displayHeight } = display.bounds;
      return x < displayX + displayWidth && x + width > displayX
        && y < displayY + displayHeight && y + height > displayY;
    });
    if (!overlapsDisplay) return null;
    return { x, y, width, height, maximized: saved.maximized };
  } catch {
    return null;
  }
}

/** Debounced-caller-safe write of a pop-out surface's bounds. Read-merge-write so sibling
 *  kinds are preserved regardless of AppConfig merge semantics for the popOutBounds
 *  dictionary. Mirrors the maximized/non-maximized split of the main window's saveBounds. */
export function savePopOutBounds(kind: PopOutKind, win: BrowserWindow, configManager: ConfigManager): void {
  if (win.isDestroyed() || win.isMinimized()) return;
  const current = configManager.load().popOutBounds ?? {};
  if (win.isMaximized()) {
    const previous = current[kind];
    if (!previous) return;
    configManager.save({ popOutBounds: { ...current, [kind]: { ...previous, maximized: true } } });
    return;
  }
  const bounds = win.getBounds();
  const displayId = screen.getDisplayMatching(bounds).id;
  configManager.save({ popOutBounds: { ...current, [kind]: { bounds, displayId, maximized: false } } });
}
