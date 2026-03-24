import path from 'node:path';
import fs from 'node:fs';
import { app, screen } from 'electron';
import { PATHS } from './config/paths';
import { THEME_BACKGROUNDS } from '../shared/types';
import type { AppConfig, ThemeMode } from '../shared/types';

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
    : path.join(app.getAppPath(), 'resources', iconFilename);
}

/** Read saved window bounds from config, with screen-boundary validation. */
export function resolveWindowBounds(): { x: number; y: number; width: number; height: number } | null {
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
    return { x, y, width, height };
  } catch {
    return null;
  }
}
